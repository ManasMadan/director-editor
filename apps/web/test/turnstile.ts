/**
 * A stand-in for Cloudflare Turnstile's script (the widget itself needs Cloudflare): it
 * renders a widget that passes at once with Cloudflare's test token, which the API with
 * captcha on accepts (its secret is Cloudflare's always-pass test key). Tests make a
 * widget's token expire or fail with `turnstile.expire()` and `turnstile.fail()`.
 */
export const FAKE_TURNSTILE = `window.turnstile = (() => {
  const widgets = new Map();
  let last = 0;
  const pass = (id) => setTimeout(() => widgets.get(id)?.callback("XXXX.DUMMY.TOKEN.XXXX"));
  return {
    render(element, options) {
      const id = String(++last);
      widgets.set(id, options);
      element.dataset.widget = id;
      pass(id);
      return id;
    },
    reset: pass,
    remove: (id) => widgets.delete(id),
    expire: () => widgets.forEach((options) => options["expired-callback"]()),
    fail: () => widgets.forEach((options) => options["error-callback"]()),
  };
})();`;
