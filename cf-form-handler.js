// RSB Form Handler (Pardot Intercept)
// Automatically detects forms with cf-form attribute and processes them via Cloudflare Worker

// ========================================
// CONFIGURATION
// ========================================
const FORM_CONFIG = {
  // Worker URL
  workerUrl: "https://rsb-form-handler.revolv3.workers.dev/",

  // Debug Mode
  debug: false,

  // Form Selectors & Attributes
  formSelector: "form[cf-form]",
  formIdAttribute: "cf-form",
  formUrlAttribute: "cf-form-url",
  redirectUrlAttribute: "cf-redirect-url",
  turnstileSiteKeyAttribute: "cf-turnstile-sitekey",

  // Submit Button Selectors
  submitButtonSelector: '[cf-form-submit="trigger"]',
  submitLabelSelector: '[cf-form-submit="button-label"]',

  // Error Handling Selectors
  errorElementSelector: '[cf-form-submit="error"]',
  errorTextSelector: '[cf-form-submit="error-text"]',

  // CSS Classes
  hideClass: "hide",

  // Loading Text
  loadingText: "Sending...",

  // Honeypot Settings
  enableHoneypot: true,
  honeypotFieldNames: [
    "honeypot_website",
    "honeypot_url",
    "honeypot_company_site",
    "honeypot_business_url",
    "bot_trap_website",
    "bot_trap_url",
    "spam_trap_site",
    "spam_trap_link",
  ],

  // UTM/Tracking Parameter Persistence
  trackingParams: {
    enabled: true,
    allowPatterns: [/^utm_/i, /^gad_/i, /^gclid$/i, /^fbclid$/i],
    sessionStorageKey: "persistQS",
  },
};

class RSBFormHandler {
  constructor() {
    this.forms = [];
    this.workerUrl = FORM_CONFIG.workerUrl;
    this.debug = FORM_CONFIG.debug;
    this.initTrackingPersistence();
    this.init();
  }

  log(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  warn(...args) {
    if (this.debug) {
      console.warn(...args);
    }
  }

  initTrackingPersistence() {
    if (!FORM_CONFIG.trackingParams.enabled) return;

    if (window.__persistQS_init) return;
    window.__persistQS_init = true;

    const isAllowed = (key) => {
      return FORM_CONFIG.trackingParams.allowPatterns.some((pattern) =>
        pattern.test(key)
      );
    };

    const filterAllowed = (queryString) => {
      const src = new URLSearchParams(queryString);
      const out = new URLSearchParams();
      src.forEach((value, key) => {
        if (isAllowed(key)) {
          out.set(key, value);
        }
      });
      return out.toString();
    };

    const incoming = window.location.search.slice(1);
    const filtered = filterAllowed(incoming);

    if (filtered) {
      sessionStorage.setItem(
        FORM_CONFIG.trackingParams.sessionStorageKey,
        filtered
      );
    }

    this.setupLinkParameterMerging();
  }

  setupLinkParameterMerging() {
    const persisted = sessionStorage.getItem(
      FORM_CONFIG.trackingParams.sessionStorageKey
    );
    if (!persisted) return;

    const mergeQuery = (href) => {
      try {
        const url = new URL(href, window.location.origin);
        if (
          url.origin !== window.location.origin ||
          !/^https?:$/i.test(url.protocol)
        ) {
          return href;
        }

        const target = url.searchParams;
        const src = new URLSearchParams(persisted);

        src.forEach((val, key) => {
          if (!target.has(key)) {
            target.set(key, val);
          }
        });

        url.search = target.toString();
        return url.toString();
      } catch (e) {
        return href;
      }
    };

    const closestAnchor = (el) => {
      while (el && el !== document && el.nodeType === 1) {
        if (el.tagName === "A" && el.hasAttribute("href")) return el;
        el = el.parentNode;
      }
      return null;
    };

    const handleClick = (ev) => {
      const a = closestAnchor(ev.target);
      if (!a) return;

      const href = a.getAttribute("href");
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:")
      )
        return;

      const merged = mergeQuery(href);
      if (merged !== href) {
        a.setAttribute("href", merged);
      }
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("auxclick", handleClick, true);
  }

  init() {
    const start = () => this.setupForms();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () =>
        this.waitForWebflow(start)
      );
    } else {
      this.waitForWebflow(start);
    }
  }

  waitForWebflow(callback) {
    const runCallback = () => {
      setTimeout(callback, 100);
    };

    if (window.Webflow && typeof window.Webflow.push === "function") {
      window.Webflow.push(runCallback);
      return;
    }

    if (Array.isArray(window.Webflow)) {
      window.Webflow.push(runCallback);
      return;
    }

    setTimeout(callback, 100);
  }

  setupForms() {
    const formElements = document.querySelectorAll(FORM_CONFIG.formSelector);
    this.log(`Found ${formElements.length} forms with cf-form attribute`);

    formElements.forEach((formElement) => {
      this.setupSingleForm(formElement);
    });
  }

  setupSingleForm(formElement) {
    const config = {
      formId: formElement.getAttribute(FORM_CONFIG.formIdAttribute),
      formUrl: formElement.getAttribute(FORM_CONFIG.formUrlAttribute),
      redirectUrl: formElement.getAttribute(FORM_CONFIG.redirectUrlAttribute),
      turnstileSiteKey: formElement.getAttribute(
        FORM_CONFIG.turnstileSiteKeyAttribute
      ),
      formElement: formElement,
      submitButton: formElement.querySelector(FORM_CONFIG.submitButtonSelector),
      submitLabel: formElement.querySelector(FORM_CONFIG.submitLabelSelector),
      errorElement: formElement.querySelector(FORM_CONFIG.errorElementSelector),
      errorText: formElement.querySelector(FORM_CONFIG.errorTextSelector),
    };

    if (!config.formUrl) {
      this.warn(`Form ${config.formId} missing cf-form-url attribute`);
      return;
    }

    this.forms.push(config);

    this.setupHoneypot(config);
    this.setupTurnstile(config);
    this.setupTrackingParams(config);
    this.setupFormSubmission(config);
    this.setupAutoResetOnEdit(config);
  }

  setupHoneypot(config) {
    if (!FORM_CONFIG.enableHoneypot) return;

    const existingHoneypot = config.formElement.querySelector(
      'input[data-honeypot="true"]'
    );
    if (existingHoneypot) return;

    const randomFieldName =
      FORM_CONFIG.honeypotFieldNames[
        Math.floor(Math.random() * FORM_CONFIG.honeypotFieldNames.length)
      ];

    const honeypotField = document.createElement("input");
    honeypotField.type = "text";
    honeypotField.name = randomFieldName;
    honeypotField.setAttribute("data-honeypot", "true");
    honeypotField.setAttribute("tabindex", "-1");
    honeypotField.setAttribute("autocomplete", "off");
    honeypotField.style.cssText = `
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      width: 1px !important;
      height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
    `;
    honeypotField.setAttribute("aria-hidden", "true");

    config.formElement.insertBefore(
      honeypotField,
      config.formElement.firstChild
    );
  }

  setupTurnstile(config) {
    if (!config.turnstileSiteKey) return;

    const container = document.createElement("div");
    container.className = "cf-turnstile";
    container.setAttribute("data-sitekey", config.turnstileSiteKey);
    container.style.marginBottom = "15px";

    if (config.submitButton) {
      config.submitButton.parentNode.insertBefore(
        container,
        config.submitButton
      );
    } else {
      config.formElement.appendChild(container);
    }

    if (
      !document.querySelector(
        'script[src^="https://challenges.cloudflare.com/turnstile"]'
      )
    ) {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }

  setupTrackingParams(config) {
    if (!FORM_CONFIG.trackingParams.enabled) return;

    const persistedParams = sessionStorage.getItem(
      FORM_CONFIG.trackingParams.sessionStorageKey
    );

    if (!persistedParams) return;

    const urlParams = new URLSearchParams(persistedParams);

    urlParams.forEach((value, key) => {
      const isAllowed = FORM_CONFIG.trackingParams.allowPatterns.some(
        (pattern) => pattern.test(key)
      );

      if (isAllowed) {
        const existingField = config.formElement.querySelector(
          `input[name="${key}"]`
        );
        if (existingField) return;

        const trackingField = document.createElement("input");
        trackingField.type = "hidden";
        trackingField.name = key;
        trackingField.value = value;
        trackingField.setAttribute("data-tracking-param", "true");

        config.formElement.insertBefore(
          trackingField,
          config.formElement.firstChild
        );
      }
    });
  }

  setupFormSubmission(config) {
    config.formElement.removeAttribute("action");
    config.formElement.removeAttribute("method");
    config.formElement.setAttribute("data-wf-ignore", "true");

    const handleSubmit = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Run standard HTML5 validation
      const isHtmlValid = config.formElement.checkValidity();

      // Run custom validation for hidden selects
      const isCustomValid = this.validateCustomSelects(config);

      if (!isHtmlValid) {
        // If it's invalid, check if the ONLY invalid fields are our custom hidden ones.
        // If so, we skip reportValidity() to avoid the "not focusable" error.
        const invalidFields = config.formElement.querySelectorAll(":invalid");
        let hasVisibleInvalid = false;
        invalidFields.forEach((field) => {
          // Simple visibility check: offsetParent is null if hidden
          // Also check if it's one of our custom selects
          const isCustomSelect = field.hasAttribute("cf-form-select");
          if (!isCustomSelect && field.offsetParent !== null) {
            hasVisibleInvalid = true;
          }
        });

        if (hasVisibleInvalid) {
          config.formElement.reportValidity();
        }
      }

      if (!isHtmlValid || !isCustomValid) {
        return false;
      }

      if (config.turnstileSiteKey) {
        const turnstileResponse = config.formElement.querySelector(
          '[name="cf-turnstile-response"]'
        );
        if (turnstileResponse && !turnstileResponse.value) {
          this.showError(config, "Please complete the captcha verification.");
          return false;
        }
      }

      this.handleFormSubmit(config);
      return false;
    };

    config.formElement.addEventListener("submit", handleSubmit, true);
    config.formElement.addEventListener("submit", handleSubmit, false);

    if (config.submitButton) {
      const newButton = config.submitButton.cloneNode(true);
      config.submitButton.parentNode.replaceChild(
        newButton,
        config.submitButton
      );
      config.submitButton = newButton;

      // Update submitLabel reference if it was inside the button
      if (FORM_CONFIG.submitLabelSelector) {
        const newLabel = config.submitButton.querySelector(
          FORM_CONFIG.submitLabelSelector
        );
        if (newLabel) {
          config.submitLabel = newLabel;
        }
      }

      config.submitButton.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();

          const isHtmlValid = config.formElement.checkValidity();
          const isCustomValid = this.validateCustomSelects(config);

          if (!isHtmlValid) {
            const invalidFields =
              config.formElement.querySelectorAll(":invalid");
            let hasVisibleInvalid = false;
            invalidFields.forEach((field) => {
              const isCustomSelect = field.hasAttribute("cf-form-select");
              if (!isCustomSelect && field.offsetParent !== null) {
                hasVisibleInvalid = true;
              }
            });

            if (hasVisibleInvalid) {
              config.formElement.reportValidity();
            }
          }

          if (isHtmlValid && isCustomValid) {
            let isCaptchaValid = true;
            if (config.turnstileSiteKey) {
              const turnstileResponse = config.formElement.querySelector(
                '[name="cf-turnstile-response"]'
              );
              if (turnstileResponse && !turnstileResponse.value) {
                isCaptchaValid = false;
                this.showError(
                  config,
                  "Please complete the captcha verification."
                );
              }
            }

            if (isCaptchaValid) {
              this.handleFormSubmit(config);
            }
          }
          return false;
        },
        true
      );
    }

    // Disable Webflow success/fail
    const webflowDone =
      config.formElement.parentElement?.querySelector(".w-form-done");
    const webflowFail =
      config.formElement.parentElement?.querySelector(".w-form-fail");
    if (webflowDone) webflowDone.style.display = "none";
    if (webflowFail) webflowFail.style.display = "none";
  }

  validateCustomSelects(config) {
    let isValid = true;
    // Find all selects with the cf-form-select attribute
    const customSelects =
      config.formElement.querySelectorAll("[cf-form-select]");

    customSelects.forEach((select) => {
      // Only check if it's required
      if (select.hasAttribute("required") && !select.value) {
        isValid = false;

        // Find the closest wrapper
        const wrapper = select.closest(".form-field-wrapper");
        if (wrapper) {
          const errorTexts = wrapper.querySelectorAll(".form-field_error-text");
          errorTexts.forEach((el) => {
            el.classList.remove("hide");
          });
        }
      } else {
        // If valid, ensure error is hidden
        const wrapper = select.closest(".form-field-wrapper");
        if (wrapper) {
          const errorTexts = wrapper.querySelectorAll(".form-field_error-text");
          errorTexts.forEach((el) => el.classList.add("hide"));
        }
      }
    });

    return isValid;
  }

  setupAutoResetOnEdit(config) {
    config.hasErrorShown = false;
    const formInputs = config.formElement.querySelectorAll(
      "input, textarea, select"
    );
    formInputs.forEach((input) => {
      if (input.getAttribute("data-honeypot") === "true") return;

      input.addEventListener("input", () => {
        if (config.hasErrorShown) {
          this.hideError(config);
        }
      });
      input.addEventListener("focus", () => {
        if (config.hasErrorShown) {
          this.hideError(config);
        }
      });
      // Added change listener for selects to clear custom errors
      input.addEventListener("change", () => {
        if (input.tagName === "SELECT") {
          const wrapper = input.closest(".form-field-wrapper");
          if (wrapper) {
            const errorTexts = wrapper.querySelectorAll(
              ".form-field_error-text"
            );
            errorTexts.forEach((el) => el.classList.add("hide"));
          }
        }
        if (config.hasErrorShown) {
          this.hideError(config);
        }
      });
    });
  }

  async handleFormSubmit(config) {
    this.hideError(config);
    this.setSubmitButtonLoading(config, true);

    try {
      const formData = this.collectFormData(config);

      let turnstileToken = null;
      if (config.turnstileSiteKey) {
        const turnstileField = config.formElement.querySelector(
          '[name="cf-turnstile-response"]'
        );
        turnstileToken = turnstileField?.value?.trim();
      }

      formData.metadata = {
        submissionTime: Date.now(),
        pageLoadTime: window.performance.timing.loadEventEnd,
        userAgent: navigator.userAgent,
        referrer: document.referrer,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        formId: config.formId,
      };

      const payload = {
        formData: formData,
        formUrl: config.formUrl,
        redirectUrl: config.redirectUrl,
        turnstileToken,
      };

      const response = await fetch(this.workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (result.success) {
        this.handleSuccess(config);
      } else {
        this.showError(
          config,
          result.error?.message || "Something went wrong. Please try again."
        );
      }
    } catch (error) {
      this.showError(
        config,
        "Network error. Please check your connection and try again."
      );
    } finally {
      this.setSubmitButtonLoading(config, false);
    }
  }

  collectFormData(config) {
    const formData = {};
    const inputs = config.formElement.querySelectorAll(
      "input, textarea, select"
    );

    inputs.forEach((input) => {
      if (input.name && input.type !== "submit") {
        if (input.type === "checkbox") {
          formData[input.name] = input.checked;
        } else if (input.type === "radio") {
          if (input.checked) {
            formData[input.name] = input.value;
          }
        } else {
          formData[input.name] = input.value;
        }
      }
    });

    if (FORM_CONFIG.enableHoneypot) {
      const honeypotField = config.formElement.querySelector(
        'input[data-honeypot="true"]'
      );
      if (honeypotField) {
        formData._honeypot_field_name = honeypotField.name;
        formData._honeypot_filled = honeypotField.value !== "";
      }
    }

    return formData;
  }

  setSubmitButtonLoading(config, loading) {
    if (!config.submitButton) return;

    if (loading) {
      config.submitButton.disabled = true;
      if (config.submitLabel) {
        config.originalButtonText = config.submitLabel.innerHTML;
        config.submitLabel.innerHTML = FORM_CONFIG.loadingText;
      }
    } else {
      config.submitButton.disabled = false;
      if (config.submitLabel && config.originalButtonText) {
        config.submitLabel.innerHTML = config.originalButtonText;
      }
    }
  }

  showError(config, message) {
    if (config.errorElement && config.errorText) {
      config.errorText.textContent = message;
      config.errorElement.classList.remove(FORM_CONFIG.hideClass);
      config.hasErrorShown = true;
    }
  }

  hideError(config) {
    if (config.errorElement) {
      config.errorElement.classList.add(FORM_CONFIG.hideClass);
      config.hasErrorShown = false;
    }
  }

  handleSuccess(config) {
    if (config.redirectUrl) {
      // Keep form visible but interactive elements disabled ideally,
      // but simpler to just show success and redirect.

      const redirectUrl = this.buildRedirectUrl(config.redirectUrl);
      setTimeout(() => {
        window.location.href = redirectUrl;
      }, 100);
    } else {
      // Native Success Mode for Webflow
      config.formElement.style.display = "none";

      const webflowDone =
        config.formElement.parentElement?.querySelector(".w-form-done");
      if (webflowDone) {
        webflowDone.style.display = "block";
      }
    }
  }

  buildRedirectUrl(redirectSlug) {
    const origin = window.location.origin;
    if (redirectSlug.startsWith("http")) return redirectSlug;

    const slug = redirectSlug.startsWith("/")
      ? redirectSlug
      : "/" + redirectSlug;
    return origin + slug;
  }
}

const rsbFormHandler = new RSBFormHandler();
window.rsbFormHandler = rsbFormHandler;
