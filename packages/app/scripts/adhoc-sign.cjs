// electron-builder afterPack hook: ad-hoc sign the unsigned .app bundle.
//
// The build is unsigned (`mac.identity: null`, no Developer ID). Out of the
// box only the Electron Mach-O carries its linker ad-hoc signature, so the
// bundle seal is broken (`codesign --verify` fails) and a quarantined
// download is reported as "damaged". An ad-hoc signature (`--sign -`)
// seals the bundle without any certificate: Gatekeeper then treats it as an
// ordinary unidentified-developer app, which the Homebrew cask clears by
// removing the quarantine attribute. Drop this hook once a real
// `mac.identity` is configured (electron-builder signs then).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log(`  • ad-hoc signed  file=${appPath}`);
};
