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
# Regenerate with: npm run cask:update

cask "souffleur" do
  version "0.1.3"

  on_arm do
    sha256 "1105dc8c999a194db3e938981ec6e58959940b3dfa488df70118cb526dc1f0da"
    url "https://github.com/akshatgg/Souffleur/releases/download/v#{version}/Souffleur-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "ec099bd98ebcf6f56a075d3f46fb6f806327af655259ba062fdc27f293e8e658"
    url "https://github.com/akshatgg/Souffleur/releases/download/v#{version}/Souffleur-#{version}.dmg"
  end

  name "Souffleur"
  desc "Screen-share-invisible AI overlay that reads your screen and hears your calls"
  homepage "https://getsouffleur.vercel.app"

  depends_on macos: :ventura

  app "Souffleur.app"

  # The build is signed but not notarised, so macOS refuses it on first launch
  # while the quarantine flag is set. Clearing it here is what makes a plain
  # `brew install --cask` open without a dialog.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Souffleur.app"],
                   must_succeed: false
  end

  uninstall quit: "com.akshatgg.souffleur"

  zap trash: [
    "~/Library/Application Support/Souffleur",
    "~/Library/Preferences/com.akshatgg.souffleur.plist",
    "~/Library/Saved Application State/com.akshatgg.souffleur.savedState",
  ]
end
