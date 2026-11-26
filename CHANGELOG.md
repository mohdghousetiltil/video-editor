# VD0 releases

The version lives in `public/app.js` (`VERSION`). Each release raises the last number by one and gets a line here.
v1.0 is kept for the first public release.

## 0.0.014606
- The app name reads VD0 everywhere: the sidebar logo said VD-0, and History, Scripts and How it works now give the
  home-screen app the same name.

## 0.0.014605
- Scripts: rom-com, comedy, kids and new-gen are the main genres (thriller, suspense and horror too), with a Genre
  box and matching ideas. The story is shown on its own, with the shot list folded underneath, instead of mixed line
  by line. The writer is told to keep stories easy to follow.

## 0.0.014604
- The original glowing app icon is back.

## 0.0.014603
- Cleaner app icon: the same corner brackets and play arrow, flat on a plain dark tile, in every size.

## 0.0.014602
- Your own prompt standard (identity preservation, adaptive reference analysis, side / back / full-body views,
  photographic realism) is built in word for word, with pronouns matched to the person and drawn or 3D characters
  kept in their style. It drives the poses, Realistic look, cameo, look change, UGC start frame, new portraits,
  clips that start from an influencer's picture, and the Enhance prompt and character writers.
- Many more voices: 32 Kokoro (US, UK, Hindi) and 21 ElevenLabs in Shorts, Story and the influencer's voice.

## 0.0.014601
- History: the card's Download button shows just its icon.

## 0.0.014600
- History cards keep just a large Download and a small ✕ to delete. Redo, Enhance and Add background music moved into the
  details view (tap the title). Titles take two lines at most. The Find filters fold away (tap Find); the header shows how many are on.
- Once a full story is made, its scene clips are no longer listed on their own: tap the story's title to play or
  download them. Choosing "Story scenes" under Kind still lists them all.

## 0.0.014599
- History: Play sits in the middle of each video's picture, and the whole thumbnail is shown, not a crop. Tapping a
  title opens its details: the large thumbnail, model, cost, date, ID, prompt (and for Shorts the description,
  hashtags and voiceover), with buttons to download the video or the thumbnail.

## 0.0.014598
- History is a two-column grid of cards (picture on top, details and buttons below), four to a screen on a phone,
  where the buttons show as icons and the model and job ID are tucked away.

## 0.0.014597
- The nav bar stays fixed in place: on the iPhone home-screen app, pulling past the top or bottom of a page no longer
  stretches the page (the rubber-band bounce) and drags the bar with it. Lists and dialogs inside a page scroll as before.

## 0.0.014596
- Face swap: the people search can no longer hang forever. Phones (iOS Safari above all) never loaded the hidden
  video, so it waited indefinitely; the video is now started muted so frames arrive. Every step has a limit
  (detector download 90 s, video 30 s, each frame 10-20 s, gender check 20 s); a frame that gets stuck is skipped,
  and if the search fails the page says why, with Try again, and the swap still works on the whole video.
- While the detector gets ready, a live "N s so far" counter shows it is still working.

## 0.0.014595
- Face swap: "Looking for people in the video" shows a progress bar and roughly how long is left, measured from
  this device's own speed. Getting the face detector ready (10-30 s the first time, a few seconds after) is its own
  step, so the estimate stays honest; a typical video then takes a few seconds.

## 0.0.014594
- Shorts cameo: face, hands and speech now match. The influencer's lips are synced to their own voice line
  (fal.ai Sync Lipsync 2.0, ~$0.05 a second), and the AI's direction is timed to the words: each expression and
  gesture is tied to the exact words it belongs to and fits their tone. Without a fal.ai key, or if syncing fails,
  the talking clip is used unsynced and the Short says so. A cameo now costs about $0.33 (picture + ~4 s clip + sync).

## 0.0.014593
- Shorts cameo is now filmed like a real short-form creator: the green-screen format (the picture large behind them,
  waist-up, eye contact, creator lighting), punchy delivery, and gestures that show the idea instead of random waving.
- The AI that writes the Short also directs every line (expression, energy, 1-2 specific gestures); the hook is played
  to stop the scroll and the last line as the payoff.

## 0.0.014592
- Influencers: once someone is animated, their card's button becomes Meet, which plays the clip. Animate again is in the
  ⋯ menu and replaces it. A new main picture clears the old clip.
- Influencers have their own voice (Edit → Voice). When one is picked as a Shorts cameo, the whole Short is spoken in it.
- Shorts maker → Pictures: the cameo now comes alive. The drawn picture becomes a short silent clip (Grok Imagine Lite,
  ~$0.03 a second) of the influencer explaining to camera with hand gestures, under their voice. If a clip can't be
  made, the still picture stays and the Short says so. The estimate and confirmation include the clips.

## 0.0.014591
- Shorts maker → Pictures: optional influencer cameo. A saved influencer is drawn into up to 3 of your pictures,
  presenting and pointing at what is being explained; each opens on the cameo, then shows your original.
- The cameo's estimated price is in the cost line and the confirmation, and each picture drawn is logged as Shorts
  spend under the picture model chosen in Settings. With no influencer picked, nothing changes.

## 0.0.014590
- Settings → "Little easter-egg glitches" now switches off every glitch effect (title tearing, sweeping beam,
  scanlines, moving grid) as well as the easter eggs, and takes effect without a reload.
- The switch starts off for everyone. Ticking it is remembered in that browser only.

## 0.0.014589
- The app is now called VD0 (for now) and shows its version in every page footer.
- Netrunner mode: a screen-break easter egg on the first tap of the + button, with 3D glass shards and
  computed spatial glass sound.
