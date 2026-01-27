(function () {
  // ============ CONFIG ============
  var TURNSTILE_SITEKEY = "0x4AAAAAACGTq9k7OhNoXCa2";

  // FIRST-PARTY COOKIE MODE:
  // Set this to a same-site endpoint so the Worker can set a first-party cookie.
  // Examples:
  // - "/turnstile/verify" (recommended)
  // - "https://verify.yourdomain.com/turnstile/verify" (still first-party if cookie Domain=.yourdomain.com)
  var VERIFY_URL = "https://verify.redshiftbio.com/turnstile/verify";

  // GTM listens for this event
  var DATALAYER_EVENT = "turnstile_passed";

  // Cookie set by Worker (must be on the website's domain to be readable by GTM)
  var VERIFIED_COOKIE_NAME = "cf_ts_verified";

  // Optional: set true to log to console for testing
  var DEBUG = true;

  // ============ HELPERS ============
  function log() {
    if (!DEBUG || !window.console) return;
    // eslint-disable-next-line no-console
    console.log.apply(console, arguments);
  }

  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp("(^|;\\s*)" + name + "=([^;]+)"),
    );
    return match ? decodeURIComponent(match[2]) : null;
  }

  function pushDataLayerEvent() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: DATALAYER_EVENT });
    log("[turnstile] pushed dataLayer event:", DATALAYER_EVENT);
  }

  function verifyToken(token) {
    return fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        token: token,
        path: location.pathname,
        ua: navigator.userAgent,
      }),
    }).then(function (r) {
      return r.json();
    });
  }

  function ensureTurnstileScriptLoaded(cb) {
    if (window.turnstile) return cb();
    var s = document.createElement("script");
    s.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = cb;
    s.onerror = function () {
      log("[turnstile] failed to load Turnstile script");
    };
    document.head.appendChild(s);
  }

  // ============ MAIN ============
  function start() {
    // Fast path: cookie already present (subsequent pages)
    if (getCookie(VERIFIED_COOKIE_NAME) === "1") {
      log("[turnstile] cookie already present; gating open");
      pushDataLayerEvent();
      return;
    }

    if (!window.turnstile || !document.body) {
      setTimeout(start, 50);
      return;
    }

    // Create a hidden mount node
    var mount = document.createElement("div");
    mount.id = "cf-turnstile-mount";
    mount.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
    document.body.appendChild(mount);

    // Render invisible widget
    var widgetId = window.turnstile.render("#cf-turnstile-mount", {
      sitekey: TURNSTILE_SITEKEY,
      size: "invisible",
      callback: function (token) {
        log("[turnstile] token received; verifying…");
        verifyToken(token)
          .then(function (res) {
            if (res && res.ok) {
              log("[turnstile] verified OK; gating open (worker cookie)");
              pushDataLayerEvent();
            } else {
              log("[turnstile] verification failed:", res);
            }
          })
          .catch(function (err) {
            log("[turnstile] verification request error:", err);
          });
      },
    });

    // Execute challenge
    try {
      window.turnstile.execute(widgetId);
    } catch (e) {
      try {
        window.turnstile.execute("#cf-turnstile-mount");
      } catch (e2) {
        log("[turnstile] execute failed:", e2);
      }
    }
  }

  ensureTurnstileScriptLoaded(start);
})();
