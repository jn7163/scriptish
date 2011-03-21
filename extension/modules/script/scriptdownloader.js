var EXPORTED_SYMBOLS = ["ScriptDownloader"];

const Cu = Components.utils;
Cu.import("resource://gre/modules/CertUtils.jsm");
Cu.import("resource://scriptish/constants.js");
Cu.import("resource://scriptish/logging.js");
Cu.import("resource://scriptish/prefmanager.js");
Cu.import("resource://scriptish/scriptish.js");
Cu.import("resource://scriptish/script/scripticon.js");
Cu.import("resource://scriptish/utils/Scriptish_alert.js");
Cu.import("resource://scriptish/utils/Scriptish_getWriteStream.js");
Cu.import("resource://scriptish/utils/Scriptish_stringBundle.js");

function ScriptDownloader(uri, contentWin) {
  this.uri_ = uri || null;
  this.req_ = null;
  this.script = null;
  this.depQueue_ = [];
  this.dependenciesLoaded_ = false;
  this.installOnCompletion_ = false;
  this.tempFiles_ = [];
  this.updateScript = false;
  this.contentWin = contentWin || null;
}
ScriptDownloader.prototype.startInstall = function() {
  this.type = "install";
  this.startDownload();
}
ScriptDownloader.prototype.startViewScript = function() {
  this.type = "view";
  this.startDownload();
}
ScriptDownloader.prototype.startUpdateScript = function(aScriptInstaller) {
  this.type = "update";
  this.secure = true;
  this.scriptInstaller = aScriptInstaller;
  this.startDownload();
  return this;
}
ScriptDownloader.prototype.startDownload = function() {
  Scriptish_log("Fetching Script");
  let req = this.req_ = Instances.xhr;
  req.overrideMimeType("text/plain");
  req.open("GET", this.uri_.spec, true);
  if (this.secure) {
    // suppress "bad certificate" dialogs and fail on redirects from a bad certificate.
    req.channel.notificationCallbacks =
        new BadCertHandler(!Scriptish_prefRoot.getValue("update.requireBuiltInCerts"));
  }
  req.onerror = this.handleErr.bind(this);
  req.onreadystatechange = this.chkContentTypeB4DL.bind(this);
  req.onload = this.handleScriptDownloadComplete.bind(this);
  req.send(null);
}
ScriptDownloader.prototype.handleErr = function() {
  if (this.scriptInstaller) this.scriptInstaller.changed("DownloadFailed");
}
ScriptDownloader.prototype.chkContentTypeB4DL = function() {
  if (this.req_.readyState != 2
      || !/text\/html/i.test(this.req_.getResponseHeader("Content-Type")))
    return;

  // If there is a 'Content-Type' header and it contains 'text/html',
  // then do not install the file, and display it instead.
  this.req_.abort();
  Services.scriptish.ignoreNextScript();
  if (this.contentWin) this.contentWin.location.href = this.uri_.spec;
}
ScriptDownloader.prototype.handleScriptDownloadComplete = function() {
  let req = this.req_;
  try {
    // If loading from file, status might be zero on success
    if (req.status != 200 && req.status != 0) {
      Scriptish_alert(Scriptish_stringBundle("error.script.loading") + ":\n" +
      req.status + ": " + req.statusText);
      return;
    }

    if (this.secure) {
      // make sure that the final URI is a https url
      if ("https" != req.channel.URI.scheme)
        return this.handleErr();

      // make sure that the final URI's certificate is valid
      try {
        checkCert(req.channel, !Scriptish_prefRoot.getValue("update.requireBuiltInCerts"));
      }
      catch (e) {
        return this.handleErr();
      }
    }

    var source = req.responseText;
    this.script = Scriptish.config.parse(source, this.uri_);

    var file = Services.dirsvc.get("TmpD", Ci.nsILocalFile);
    var base = this.script.name.replace(/[^A-Z0-9_]/gi, "").toLowerCase();
    file.append(base + ".user.js");
    file.createUnique(Ci.nsILocalFile.NORMAL_FILE_TYPE, 0640);
    this.tempFiles_.push(file);

    var converter = Instances.suc;
    converter.charset = "UTF-8";
    source = converter.ConvertFromUnicode(source);

    var ws = Scriptish_getWriteStream(file);
    ws.write(source, source.length);
    ws.close();

    this.script.setDownloadedFile(file);

    timeout(this.fetchDependencies.bind(this));

    switch (this.type) {
      case "install":
        this._callback = function() {
          this.showInstallDialog();
          delete this._callback;
        }
        break;
      case "view":
        this.showScriptView();
        break;
    }

  } catch (e) {
    Scriptish_alert(Scriptish_stringBundle("error.script.installing") + ": " + e);
    throw e;
  }
}
ScriptDownloader.prototype.fetchDependencies = function() {
  Scriptish_log("Fetching Dependencies");

  var deps = this.script.requires.concat(this.script.resources);
  // if this.script.icon._filename exists then the icon is a data scheme
  if (this.script.icon.hasDownloadURL())
    deps.push(this.script.icon);

  for (let [, dep] in Iterator(deps)) {
    if (this.checkDependencyURL(dep.urlToDownload)) {
      this.depQueue_.push(dep);
    } else {
      let errMsg = Scriptish_stringBundle("error.dependency.local");
      if (dep instanceof ScriptIcon) {
        dep._script.resetIcon();
        Scriptish_logError(new Error(
            Scriptish_stringBundle("error.dependency.loading") + ": " +
            dep.urlToDownload + "\n" + errMsg));
      } else {
        this.errorInstallDependency(dep, errMsg);
        return;
      }
    }
  }
  this.downloadNextDependency();
}
ScriptDownloader.prototype.downloadNextDependency = function() {
  if (!this.depQueue_.length) {
    this.dependenciesLoaded_ = true;
    this._callback && this._callback();
    this.finishInstall();
    return;
  }

  var tools = {};
  var dep = this.depQueue_.pop();
  Cu.import("resource://scriptish/utils/Scriptish_getTempFile.js", tools);
  try {
    var persist = Instances.wbp;
    persist.persistFlags =
        persist.PERSIST_FLAGS_BYPASS_CACHE |
        persist.PERSIST_FLAGS_REPLACE_EXISTING_FILES; //doesn't work?

    var sourceUri = NetUtil.newURI(dep.urlToDownload);

    if (this.secure) {
      // make sure that the dependency's URI is a https url
      if ("https" != sourceUri.scheme)
        return this.errorInstallDependency(dep, "Insecure dependency URI");
    }

    var sourceChannel = Services.io.newChannelFromURI(sourceUri);
    sourceChannel.notificationCallbacks = (this.secure)
        ? new BadCertHandler(!Scriptish_prefRoot.getValue("update.requireBuiltInCerts"))
        : new NotificationCallbacks();

    var file = tools.Scriptish_getTempFile();
    this.tempFiles_.push(file);

    var progressListener = new PersistProgressListener(persist);
    progressListener.onFinish =
        this.handleDependencyDownloadComplete.bind(this, dep, file, sourceChannel);
    persist.progressListener = progressListener;
    persist.saveChannel(sourceChannel, file);
  } catch (e) {
    Scriptish_log("Download exception " + e);
    this.errorInstallDependency(dep, e);
  }
}
ScriptDownloader.prototype.handleDependencyDownloadComplete =
    function(dep, file, channel) {
  Scriptish_log("Dependency Download complete " + dep.urlToDownload);
  try {
    var httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
  } catch(e) {
    var httpChannel = false;
  }

  if (this.secure) {
    // make sure that the final URI is a https url
    if ("https" != channel.URI.scheme)
      return this.errorInstallDependency(dep, "Insecure dependency URI");

    // make sure that the final URI's certificate is valid
    try {
      checkCert(channel, !Scriptish_prefRoot.getValue("update.requireBuiltInCerts"));
    }
    catch (e) {
      return  this.errorInstallDependency(dep, "Invalid dependency SSL certificate");
    }
  }

  let errMsgStart = Scriptish_stringBundle("error.dependency.loading") + ": " +
      dep.urlToDownload + "\n";
  if (httpChannel) {
    if (httpChannel.requestSucceeded) {
      if (this.updateScript) {
        dep._script = this.script;
        dep.updateScript = true;
      }

      if (dep instanceof ScriptIcon && !dep.isImage(channel.contentType)) {
        file.remove(false);
        dep._script.resetIcon();
        Scriptish_logError(new Error(
            errMsgStart + Scriptish_stringBundle("error.icon.notImage")));
        this.downloadNextDependency();
        return;
      }

      dep.setDownloadedFile(file, channel.contentType, channel.contentCharset ? channel.contentCharset : null);
      this.downloadNextDependency();
    } else {
      let errMsg = Scriptish_stringBundle("error.dependency.serverReturned") + ": "
          + httpChannel.responseStatus + ": " + httpChannel.responseStatusText;

      if (dep instanceof ScriptIcon) {
        file.remove(false);
        dep._script.resetIcon();
        Scriptish_logError(new Error(errMsgStart + errMsg));
        this.downloadNextDependency();
      } else {
        this.errorInstallDependency(dep, errMsg);
      }
    }
  } else {
    dep.setDownloadedFile(file);
    this.downloadNextDependency();
  }
}
ScriptDownloader.prototype.checkDependencyURL = function(url) {
  var scheme = Services.io.extractScheme(url);

  switch (scheme) {
    case "http":
    case "https":
    case "ftp":
        return true;
    case "file":
        var scriptScheme = Services.io.extractScheme(this.uri_.spec);
        return (scriptScheme == "file")
    default:
      return false;
  }
}
ScriptDownloader.prototype.finishInstall = function() {
  if (this.updateScript) {
    // Inject the script now that we have the new dependencies
    this.script.useDelayedInjectors();

    // Save new values to config.xml
    this.script._config._save();
  } else if (this.installOnCompletion_) {
    this.installScript();
  } else if (this.scriptInstaller) {
    this.scriptInstaller.changed("DownloadEnded");
  }
}
ScriptDownloader.prototype.errorInstallDependency = function(dep, msg) {
  this.dependencyError = Scriptish_stringBundle("error.dependency.loading") + ": "
      + dep.urlToDownload + "\n" + msg;
  Scriptish_log(this.dependencyError);
  if (this.scriptInstaller) return this.scriptInstaller.changed("DownloadFailed");
  if (this.installOnCompletion_) Scriptish_alert(this.dependencyError);
  this._callback && this._callback();
}
ScriptDownloader.prototype.installScript = function() {
  if (this.dependencyError) {
    Scriptish_alert(this.dependencyError, 0);
    return false;
  } else if (this.scriptInstaller && this.dependenciesLoaded_) {
    this.scriptInstaller._script.replaceScriptWith(this.script);
    this.scriptInstaller.changed("InstallEnded");
  } else if (this.dependenciesLoaded_) {
    var script = this.script;
    Scriptish.config.install(script);
  } else {
    this.installOnCompletion_ = true;
  }
  return true;
}
ScriptDownloader.prototype.cleanupTempFiles = function() {
  for (let [, file] in Iterator(this.tempFiles_))
    file.exists() && file.remove(false);
}
ScriptDownloader.prototype.showInstallDialog = function(aTimer) {
  if (!aTimer)
    return timeout(this.showInstallDialog.bind(this, 1));

  Services.wm.getMostRecentWindow("navigator:browser").openDialog(
      "chrome://scriptish/content/install.xul", "",
      "chrome,centerscreen,modal,dialog,titlebar,resizable", this);
}
ScriptDownloader.prototype.showScriptView = function() {
  Services.wm.getMostRecentWindow("navigator:browser")
      .Scriptish_BrowserUI.showScriptView(this, this.script.previewURL);
}


function NotificationCallbacks() {}
NotificationCallbacks.prototype.QueryInterface = function(aIID) {
  if (aIID.equals(Ci.nsIInterfaceRequestor))
    return this;
  throw Components.results.NS_NOINTERFACE;
}
NotificationCallbacks.prototype.getInterface = function(aIID) {
  if (aIID.equals(Ci.nsIAuthPrompt))
    return Services.ww.getNewAuthPrompter(winWat.activeWindow);
  return undefined;
}


function PersistProgressListener(persist) {
  this.persist = persist;
  this.onFinish = function(){};
  this.persiststate = "";
}

PersistProgressListener.prototype.QueryInterface = function(aIID) {
  if (aIID.equals(Ci.nsIWebProgressListener)) return this;
  throw Components.results.NS_NOINTERFACE;
};

// nsIWebProgressListener
PersistProgressListener.prototype.onProgressChange =
    PersistProgressListener.prototype.onLocationChange =
        PersistProgressListener.prototype.onStatusChange =
            PersistProgressListener.prototype.onSecurityChange = function(){};

PersistProgressListener.prototype.onStateChange =
  function(aWebProgress, aRequest, aStateFlags, aStatus) {
    if (this.persist.currentState == this.persist.PERSIST_STATE_FINISHED) {
      Scriptish_log("Persister: Download complete " + aRequest.status);
      this.onFinish();
    }
  };
