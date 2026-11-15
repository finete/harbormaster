# Homebrew cask for Harbormaster, published from finete/homebrew-tap
# (Casks/harbormaster.rb). This copy is the template: release/release.sh
# rewrites `version` and `sha256` here and in the tap checkout on every
# release. Install: brew install --cask finete/tap/harbormaster
cask "harbormaster" do
  version "0.2.2"
  sha256 "55a54b4534224e2d0d5dc9f234e6a06154c8176683b3f9cf41e368e8b37f4816"

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
