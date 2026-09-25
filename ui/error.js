const parameters = new URLSearchParams(location.search);
const target = parameters.get("target") || "";
const message = parameters.get("message") || "请检查网站地址或稍后重试。";
const code = parameters.get("code") || "";

document.getElementById("message").textContent = message;
document.getElementById("target").textContent = target;
document.getElementById("code").textContent = code ? `错误代码 ${code}` : "";
if (target.startsWith("http://") || target.startsWith("https://")) {
  document.getElementById("retry").href = target;
}
