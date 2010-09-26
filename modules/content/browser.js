
var EXPORTED_SYMBOLS = ["Scriptish_BrowserUIM"];

const Cu = Components.utils;
Cu.import("resource://scriptish/utils/Scriptish_setEnabled.js");
Cu.import("resource://scriptish/utils/Scriptish_getEnabled.js");
Cu.import("resource://scriptish/utils/Scriptish_stringBundle.js");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(
    this, "winWatcher", "@mozilla.org/embedcomp/window-watcher;1",
    "nsIWindowWatcher");

XPCOMUtils.defineLazyServiceGetter(
    this, "winMediator", "'@mozilla.org/appshell/window-mediator;1",
    "nsIWindowMediator");

function Scriptish_BrowserUIM(aWin, aBrowserUI) {
  this._win = aWin;
  this._browserUI = aBrowserUI;
}
Scriptish_BrowserUIM.prototype = {
  onIconClick: function(aEvt) {
    if (!aEvt.button)
      this.onToggleStatus();
    else if (aEvt.button == 1)
      this._win.BrowserOpenAddonsMgr('userscripts');
  },
  onToggleStatus: function() {
    Scriptish_setEnabled(!Scriptish_getEnabled());
  },
  refreshStatus: function() {
    var img = this._win.document.getElementById("scriptish-status-image");
    var menu = this._win.document.getElementById("scriptish_general_menu");

    if (Scriptish_getEnabled()) {
      img.setAttribute("src", "chrome://scriptish/skin/icon_small.png");
      menu.setAttribute("image", "chrome://scriptish/skin/icon_small.png");
      img.tooltipText = Scriptish_stringBundle("tooltip.enabled");
    } else {
      img.setAttribute("src", "chrome://scriptish/skin/icon_small_disabled.png");
      menu.setAttribute("src", "chrome://scriptish/skin/icon_small_disabled.png");
      img.tooltipText = Scriptish_stringBundle("tooltip.disabled");
    }
  },
  openChromeWindow: function(aURL) {
    winWatcher.openWindow(
      this._win, aURL, null, "chrome,dependent,centerscreen,resizable,dialog", null);
  },
  newUserScript: function() {
    this.openChromeWindow("chrome://scriptish/content/newscript.xul");
  },
  openOptionsWin: function() {
    this.openChromeWindow("chrome://scriptish/content/options.xul");
  },
  showUserscriptList: function() {
    Cu.import("resource://scriptish/addonprovider.js");
    this._win.setTimeout("BrowserOpenAddonsMgr('addons://list/userscripts')", 0);
  }
}
