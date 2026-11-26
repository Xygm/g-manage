// 在样式和脚本加载前确定外观与平台，避免首帧闪白、标题栏错位。
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem("gam-theme");
    if (t === "light" || t === "dark") root.dataset.theme = t;
  } catch (e) {}
  var q = new URLSearchParams(location.search).get("shell");
  var shell = q || window.gamShell || "";
  if (!shell) shell = /Mac/i.test(navigator.platform) ? "web-mac" : "web";
  root.dataset.shell = shell;
  root.dataset.os = shell.indexOf("mac") >= 0 ? "mac" : "win";
})();
