/**
 * 避免 signAndEditExecutable（会拉取 winCodeSign，在未开开发者模式时因符号链接失败）。
 * 打包完成后用 rcedit 写入应用图标，并在安装目录旁放一份 SEIAndroidTVTestToolBox.ico。
 */
const fs = require("node:fs");
const path = require("node:path");

const APP_NAME = "SEIAndroidTVTestToolBox";

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(__dirname, "build", "icon.ico");
  const fallbackIcon = path.join(__dirname, "electron", "icon.ico");
  const icon = fs.existsSync(iconPath)
    ? iconPath
    : fs.existsSync(fallbackIcon)
      ? fallbackIcon
      : "";

  if (!icon || !fs.existsSync(exePath)) {
    console.warn("[afterPack] skip icon: missing exe or ico");
    return;
  }

  const rcedit = require("rcedit");
  await rcedit(exePath, {
    icon,
    "version-string": {
      ProductName: APP_NAME,
      FileDescription: APP_NAME,
      CompanyName: APP_NAME,
    },
  });

  // 确保安装根目录有独立 ico（与 extraFiles 双保险）
  const sideIcon = path.join(context.appOutDir, `${APP_NAME}.ico`);
  try {
    fs.copyFileSync(icon, sideIcon);
  } catch (err) {
    console.warn(`[afterPack] copy ${APP_NAME}.ico failed:`, err);
  }

  console.log(`[afterPack] icon applied: ${exePath}`);
};
