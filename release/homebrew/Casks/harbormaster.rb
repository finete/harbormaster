# Homebrew cask for Harbormaster, published from finete/homebrew-tap
# (Casks/harbormaster.rb). This copy is the template: release/release.sh
# rewrites `version` and `sha256` here and in the tap checkout on every
# release. Install: brew install --cask finete/tap/harbormaster
cask "harbormaster" do
  version "0.3.1"
  sha256 "514eae4d4d5df19ce2c6b381f80c80f1f2c5454b8c7b2a5b4653e993b3c1d08c"

  url "https://github.com/finete/harbormaster/releases/download/v#{version}/Harbormaster-#{version}-arm64-mac.zip"
  name "Harbormaster"
  desc "Kanban board for coding-agent tasks, one worktree and session per task"
  homepage "https://github.com/finete/harbormaster"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on :macos

  app "Harbormaster.app"
  # The `harbormaster` CLI (agent tools, MCP server, hooks) ships inside the
  # app and runs on the app's own Electron in Node mode.
  binary "#{appdir}/Harbormaster.app/Contents/Resources/bin/harbormaster"

  # The build is unsigned (ad-hoc signature only, no notarization). Clear the
  # quarantine flag so Gatekeeper does not refuse to open it.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Harbormaster.app"]
  end

  # ~/.harbormaster (tasks, rules, inbox) is user data and deliberately not
  # zapped; remove it by hand if you really want a clean slate.
  zap trash: [
    "~/Library/Application Support/Harbormaster",
    "~/Library/Preferences/dev.finete.harbormaster.plist",
    "~/Library/Saved Application State/dev.finete.harbormaster.savedState",
  ]
end
