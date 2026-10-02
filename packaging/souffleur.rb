# Homebrew cask for Souffleur.
#
# Homebrew ADDS com.apple.quarantine to casks by default -- it does not remove
# it. Without the postflight below, a brew install still produces the "Apple
# could not verify" dialog, exactly like downloading the DMG by hand.
#
# The postflight clears the flag, which is the same permission the System
# Settings approval grants. Users can also pass --no-quarantine themselves.
#
# This does NOT make the app notarised. Notarisation needs a paid Developer ID;
# see docs/SIGNING.md.
#
# Lives in the akshatgg/homebrew-tap repository as Casks/souffleur.rb.
# The release workflow regenerates and publishes it; by hand: npm run cask:update

cask "souffleur" do
  version "0.1.6"

  on_arm do
    sha256 "b5abdf4c05a83d143d00c52974b5f3ba07492d5f26e4a011827305569a029849"
    url "https://github.com/akshatgg/souffleur-releases/releases/download/v#{version}/Souffleur-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "50dbbe5fcd2d20731117f6dc7e0bf9378c6f7ed1d889cfaf1907bab97b5cfdf8"
    url "https://github.com/akshatgg/souffleur-releases/releases/download/v#{version}/Souffleur-#{version}.dmg"
  end

  name "Souffleur"
  desc "Screen-share-invisible AI overlay that reads your screen and hears your calls"
  homepage "https://getsouffleur.vercel.app"

  depends_on macos: :ventura

  app "Souffleur.app"

  # The build is signed but not notarised, so macOS refuses it on first launch
  # while the quarantine flag is set. Clearing it here is what makes a plain
  # `brew install --cask` open without a dialog.
  postflight_steps do
    run "/usr/bin/xattr",
        args:         ["-dr", "com.apple.quarantine", "{{appdir}}/Souffleur.app"],
        must_succeed: false
  end

  uninstall quit: "com.akshatgg.souffleur"

  zap trash: [
    "~/Library/Application Support/Souffleur",
    "~/Library/Preferences/com.akshatgg.souffleur.plist",
    "~/Library/Saved Application State/com.akshatgg.souffleur.savedState",
  ]
end
