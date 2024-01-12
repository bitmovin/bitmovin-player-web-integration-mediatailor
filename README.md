# Bitmovin Player MediaTailor Integration

This is an open-source project to enable the use of a third-party component (MediaTailor) with the Bitmovin Player Web SDK.

## What this integration is and is not
Currently, this intended to provide an example of how the Bitmovin Player can be used with MediaTailor SSAI. This is not an officially supported integration by Bitmovin.

## Maintenance and Update

This project is not part of a regular maintenance or update schedule. For any update requests, please take a look at the guidance further below.

## Contributions to this project

As an open-source project, we are pleased to accept any and all changes, updates and fixes from the community wishing to use this project. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for more details on how to contribute.

## Reporting player bugs

If you come across a bug related to the player, please raise this through your support ticketing system.

## Need more help?

Should you want some help updating this project (update, modify, fix or otherwise) and can't contribute for any reason, please raise your request to your Bitmovin account team, who can discuss your request.

## Support and SLA Disclaimer

As an open-source project and not a core product offering, any request, issue or query related to this project is excluded from any SLA and Support terms that a customer might have with either Bitmovin or another third-party service provider or Company contributing to this project. Any and all updates are purely at the contributor's discretion.

Thank you for your contributions!

## Usage

This integration completely encapsulates the usage of MediaTailor. After creating the player it can be used like a normal [Bitmovin Player](https://bitmovin.com/docs/player) instance.

## Supported Features & Workflows
### Stream Types:
- [x] VoD :white_check_mark:
  - [x] Linear Ads :white_check_mark:
  - [x] Companion Ad Rendering :white_check_mark:
  - [x] Linear Video ClickThrough :white_check_mark:
- [ ] Live(Channel Assembly) :x:
### Beaconing:
- [x] Advert TrackingEvents
  - [x] Player Operation Events :white_check_mark:
    - [x] mute :white_check_mark:
    - [x] unmute :white_check_mark:
    - [x] pause :white_check_mark:
    - [x] resume :white_check_mark:
    - [x] playerExpand :white_check_mark:
    - [x] playerCollapse :white_check_mark:
    - [x] skip :white_check_mark:
    - [ ] rewind :x: (seeking during Ads no allowed)
    - [ ] notUsed :x:
    - [ ] optional :x:
    - [x] clickTracking :white_check_mark:
    - [x] customClick :white_check_mark:
    - [x] error :white_check_mark: currently only errorcode '400' - 'General Linear error. Media player is unable to display the Linear Ad' is used
  - [x] Linear Ad Metrics :white_check_mark:
    - [x] loaded :white_check_mark:
    - [x] start :white_check_mark:
    - [x] firstQuartile :white_check_mark:
    - [x] midpoint :white_check_mark:
    - [x] thirdQuartile :white_check_mark:
    - [x] complete :white_check_mark:
    - [x] progress :white_check_mark:
    - [ ] otherAdInteraction :x:
    - [ ] closeLinear :x: (Need to implement if allowed to close CompanionAds)
  - [ ] Ad Verification Events :x:
    - [ ] verificationNotExecuted :x:
    - [ ] ExecutableResource :x:
    - [ ] JavascriptResource :x:
  - [ ] Companion Ad Tracking :x:
    - [x] Companion Tracking Events :white_check_mark:
      - [x] creativeView :white_check_mark:
    - [x] Companion Click Tracking :white_check_mark:
- [x] AdBreak TrackingEvents :white_check_mark:
  - [x] breakStart :white_check_mark:
  - [x] breakEnd :white_check_mark:
  - [x] error :white_check_mark: currently only errorcode '400' - 'General Linear error. Media player is unable to display the Linear Ad' is used
- [ ] Open Measurement SDK (AdVerifications not yet implemented)

## Ad Beaconing & Tracking

This integration utilizes MediaTailor's [Client-Side Tracking](https://docs.aws.amazon.com/mediatailor/latest/ug/ad-reporting-client-side.html) for ad tracking data. This integration will handle firing of the ad & adbreak beacons provided by MedaiTailor's Client-Side tracking JSON

### Sample Apps

1. Follow the instructions on [MediaTailor's Getting Started Guide](https://docs.aws.amazon.com/mediatailor/latest/ug/getting-started.html) to configure and create you SSAI Stream
2. Run `npm install`
3. Run `npm start`

### Basic Setup
```ts
const playerConfig: PlayerConfig = {
    key: 'YOUR-PLAYER-KEY', 
    ui: false
};

const playerContainer = document.getElementById('player');
const bitmovinMtPlayer = new BitmovinMediaTailorPlayer(Player, playerContainer, playerConfig);

// Load a new MediaTailor source
const source: MtSourceConfig = {
    title: 'VOD Stream',
    assetType: bitmovin.player.ads.mediatailor.MtAssetType.VOD,
    sessionInitUrl: "<MediaTailor Session Initialization Url>", //https://docs.aws.amazon.com/mediatailor/latest/ug/ad-reporting-client-side.html#ad-reporting-client-side-session-configured-features
    // or sessionInitUrl can by type of MtSessionResponse
    //sessionInitUrl: {
    //    manifestUrl: '<Session Manifest URL after Initialization>',
    //    trackingUrl: '<Session Tracking URL after Initialization>'
    //}
};

bitmovinMtPlayer.load(source);

// Create the UI afterwards (see https://github.com/bitmovin/bitmovin-player-ui for details)
const uiManager = UIFactory.buildDefaultUI(player);
```
### Advanced Setup

#### Policy

As there can be different rules for different use-cases we provide a `BitmovinMediaTailorPlayerPolicy` interface which can be implemented.
In this policy you can define which actions should be allowed during playback.

You can set the policy right after initialization(and before calling load() method) by calling:

```js
bitmovinMtPlayer.setPolicy(...); // pass in your policy object which implements BitmovinMediaTailorPlayerPolicy
```

We also provide a default policy(DefaultBitmovinMtPlayerPolicy).  
See [BitmovinMediaTailorPlayerPolicy](./src/ts/MediaTailorTypes.ts) for more details.

#### Config

You can pass a third optional parameter to the player constructor:

```js
const mtConfig: MtConfiguration = {
  debug: true,
};
// ...
const bitmovinMtPlayer = new BitmovinMediaTailorPlayer(Player, playerContainer, playerConfig, mtConfig);
```
## Development, Contribution, Releases

### Set up environment

1. Use node.js version specified in `.nvmrc`
2. Run `npm ci`
3. Use `npm run start` to run a webpack dev server

### Branching & Releasing

- This repo uses git-flow and semantic versioning
- PRs should be made against `develop` branch
- PRs should always contain an update of the [CHANGELOG.md](CHANGELOG.md) file
- New versions will be manually released into the `main` branch and tagged there

### Principles

- The Bitmovin Player shall not be packaged into the JS file created by the build of this integration. To achieve this, types can be imported and used, but no code must be imported/used (including string enums!)
