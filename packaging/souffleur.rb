# Homebrew cask for Souffleur.
#
# Homebrew strips the com.apple.quarantine flag when installing a cask, so the
# "Apple could not verify" dialog never appears. That is the same permission the
# System Settings button grants, applied on the user's behalf.
#
# This does NOT make the app notarised. Notarisation needs a paid Developer ID;
# see docs/SIGNING.md.
#
# Lives in the akshatgg/homebrew-tap repository as Casks/souffleur.rb.
# Regenerate with: npm run cask:update

cask "souffleur" do
  version "0.1.1"

  on_arm do
    sha256 "ca800545c793320bcf34bf3f310e6119e6e7a85050df27f0dfc17180840c5526"
    url "https://github.com/akshatgg/Souffleur/releases/download/v#{version}/Souffleur-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "a90ae43c806f333bde8b14ee55d906d538ba23b83537f7dd2dac6ed9dead3a19"
    url "https://github.com/akshatgg/Souffleur/releases/download/v#{version}/Souffleur-#{version}.dmg"
  end

  name "Souffleur"
  desc "Screen-share-invisible AI overlay that reads your screen and hears your calls"
  homepage "https://getsouffleur.vercel.app"

  depends_on macos: ">= :ventura"

  app "Souffleur.app"

  uninstall quit: "com.akshatgg.souffleur"

  zap trash: [
    "~/Library/Application Support/Souffleur",
    "~/Library/Preferences/com.akshatgg.souffleur.plist",
    "~/Library/Saved Application State/com.akshatgg.souffleur.savedState",
  ]
end
