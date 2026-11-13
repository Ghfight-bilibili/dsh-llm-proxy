window.__ModuleLoader__.load({
  id: "dsh-llm-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    function Panel() {
      var origin = window.location && window.location.origin ? window.location.origin : "";
      var fullUrl = origin + "/clash-proxy";
      var frameUrl = fullUrl + "?embed=1";
      var overlayState = React.useState(false);
      var overlay = overlayState[0];
      var setOverlay = overlayState[1];
      var openState = React.useState("");
      var openMessage = openState[0];
      var setOpenMessage = openState[1];

      var openExternal = function () {
        setOpenMessage("正在用系统浏览器打开…");
        fetch(origin + "/clash-proxy/api/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: fullUrl })
        }).then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || !data || data.ok === false) {
              var detail = data && data.error && data.error.message ? data.error.message : ("HTTP " + response.status);
              throw new Error(detail);
            }
            return data;
          });
        }).then(function () {
          setOpenMessage("已在系统浏览器中打开");
        }).catch(function (error) {
          try {
            window.open(fullUrl, "_blank", "noopener,noreferrer");
            setOpenMessage("已请求系统浏览器打开");
          } catch (fallbackError) {
            setOpenMessage("系统浏览器打开失败：" + (error && error.message ? error.message : error));
          }
        });
      };

      var openFullPage = function () {
        setOverlay(true);
        setOpenMessage("完整页面已打开");
        openExternal();
      };

      var closeOverlay = function () {
        setOverlay(false);
        setOpenMessage("");
      };

      var patchEmbeddedFrame = function (event) {
        try {
          var frame = event && event.currentTarget;
          var doc = frame && frame.contentDocument;
          var button = doc && doc.getElementById("fullBtn");
          if (!button) return;
          var replacement = doc.createElement("button");
          replacement.id = "fullBtn";
          replacement.className = button.className;
          replacement.type = "button";
          replacement.textContent = "打开完整页面";
          replacement.title = "在 DSH 内打开完整页面，并同时尝试系统浏览器";
          replacement.addEventListener("click", function (event) {
            event.preventDefault();
            openFullPage();
          });
          button.replaceWith(replacement);
        } catch (error) {}
      };

      var overlayView = null;
      if (overlay) {
        overlayView = h("div", { className: "dsh-llm-proxy-overlay", role: "dialog", "aria-modal": "true" },
          h("div", { className: "dsh-llm-proxy-overlay-head" },
            h("div", null,
              h("div", { className: "dsh-llm-proxy-overlay-title" }, "DSH LLM Proxy · 完整页面"),
              h("div", { className: "dsh-llm-proxy-overlay-sub" }, "完整功能已在当前窗口打开；如系统浏览器没有出现，可点右侧按钮重试。")
            ),
            h("div", { className: "dsh-llm-proxy-overlay-actions" },
              h("button", { className: "dsh-llm-proxy-open", type: "button", onClick: openExternal }, "在系统浏览器中打开"),
              h("button", { className: "dsh-llm-proxy-close", type: "button", onClick: closeOverlay }, "关闭")
            )
          ),
          h("iframe", { className: "dsh-llm-proxy-overlay-frame", src: frameUrl, title: "DSH LLM Proxy 完整控制面板" })
        );
      }

      return h("div", { className: "dsh-llm-proxy-panel" },
        h("style", null,
          ".dsh-llm-proxy-panel{width:100%;color:inherit}" +
          ".dsh-llm-proxy-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;margin-bottom:12px;border-radius:16px;" +
          "background:rgba(255,255,255,.56);border:1px solid rgba(255,255,255,.72);" +
          "box-shadow:0 18px 48px rgba(31,56,102,.12),inset 0 1px 0 rgba(255,255,255,.9);" +
          "-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%)}" +
          ".dsh-llm-proxy-title{font-weight:700;font-size:14px;letter-spacing:.2px;display:flex;align-items:center;gap:9px}" +
          ".dsh-llm-proxy-dot{width:8px;height:8px;border-radius:50%;background:#4f8cff;box-shadow:0 0 0 4px rgba(79,140,255,.16)}" +
          ".dsh-llm-proxy-sub{opacity:.62;font-size:12px;margin-top:3px}" +
          ".dsh-llm-proxy-actions{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none}" +
          ".dsh-llm-proxy-open{height:30px;padding:0 12px;border:0;cursor:pointer;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;" +
          "font:inherit;font-size:12px;font-weight:650;text-decoration:none;color:#fff;white-space:nowrap;" +
          "background:linear-gradient(135deg,#4f8cff,#6f7cff);box-shadow:0 8px 20px rgba(79,140,255,.28),inset 0 1px 0 rgba(255,255,255,.28)}" +
          ".dsh-llm-proxy-open:hover{filter:brightness(1.04)}" +
          ".dsh-llm-proxy-open:disabled{opacity:.55;cursor:not-allowed}" +
          ".dsh-llm-proxy-msg{max-width:240px;text-align:right;font-size:11px;line-height:1.35;opacity:.68}" +
          ".dsh-llm-proxy-frame{width:100%;height:min(74vh,780px);min-height:540px;display:block;border-radius:16px;" +
          "border:1px solid rgba(127,127,127,.22);background:transparent}" +
          ".dsh-llm-proxy-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;gap:12px;padding:18px;" +
          "background:radial-gradient(120% 100% at 50% 0%,rgba(79,140,255,.22),rgba(8,14,26,.86) 58%),rgba(8,14,26,.88);" +
          "-webkit-backdrop-filter:blur(26px) saturate(150%);backdrop-filter:blur(26px) saturate(150%)}" +
          ".dsh-llm-proxy-overlay-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-radius:16px;" +
          "background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);color:#fff;" +
          "box-shadow:inset 0 1px 0 rgba(255,255,255,.16)}" +
          ".dsh-llm-proxy-overlay-title{font-size:15px;font-weight:750;letter-spacing:.2px}" +
          ".dsh-llm-proxy-overlay-sub{font-size:12px;line-height:1.4;opacity:.7;margin-top:3px}" +
          ".dsh-llm-proxy-overlay-actions{display:flex;gap:8px;flex:none;align-items:center}" +
          ".dsh-llm-proxy-close{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;font-weight:650;" +
          "color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22)}" +
          ".dsh-llm-proxy-close:hover{background:rgba(255,255,255,.18)}" +
          ".dsh-llm-proxy-overlay-frame{flex:1;width:100%;min-height:0;display:block;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:#fff}" +
          "@media (prefers-color-scheme:dark){" +
          ".dsh-llm-proxy-bar{background:rgba(13,21,36,.64);border-color:rgba(255,255,255,.12);" +
          "box-shadow:0 18px 48px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.07)}" +
          ".dsh-llm-proxy-frame{border-color:rgba(255,255,255,.14)}" +
          ".dsh-llm-proxy-overlay-frame{background:#0d1524}}"
        ),
        h("div", { className: "dsh-llm-proxy-bar" },
          h("div", null,
            h("div", { className: "dsh-llm-proxy-title" },
              h("span", { className: "dsh-llm-proxy-dot" }),
              "DSH LLM Proxy"
            ),
            h("div", { className: "dsh-llm-proxy-sub" }, "订阅、节点选择、代理范围与绕行规则 · v0.4.0")
          ),
          h("div", { className: "dsh-llm-proxy-actions" },
            h("button", {
              className: "dsh-llm-proxy-open",
              type: "button",
              onClick: openFullPage
            }, "打开完整页面"),
            openMessage ? h("div", { className: "dsh-llm-proxy-msg" }, openMessage) : null
          )
        ),
        h("iframe", {
          className: "dsh-llm-proxy-frame",
          src: frameUrl,
          title: "DSH LLM Proxy 控制面板",
          onLoad: patchEmbeddedFrame
        }),
        overlayView
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.slots.inject("settings.section", function () {
            return ctx.slots.register({
              name: "settings.section",
              id: "clash-proxy",
              order: 120,
              label: function () { return "DSH LLM Proxy"; },
              inject: function () { return {}; }
            }, Panel);
          });
        } catch (error) {
          if (typeof console !== "undefined" && console.warn) console.warn("dsh-llm-proxy: settings section unavailable", error);
          return function () {};
        }
      }, "dsh-llm-proxy: settings section");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
