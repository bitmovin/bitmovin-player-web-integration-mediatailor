import {BitmovinMediaTailorAPI} from "./BitmovinMediaTailorAPI";
import {
    Ad,
    AdBreak,
    AdBreakEvent,
    AdConfig,
    AdEvent,
    AdManifestLoadedEvent, AdQuartile, AdQuartileEvent,
    LinearAd,
    PlaybackEvent,
    PlayerAdvertisingAPI,
    PlayerAPI,
    PlayerBufferAPI,
    PlayerEvent,
    PlayerEventBase,
    PlayerEventCallback,
    SeekEvent,
    SourceConfig,
    TimeChangedEvent,
    UserInteractionEvent,
    VastAdExtension
} from "bitmovin-player";
import {
    BitmovinMediaTailorPlayerPolicy,
    DefaultBitmovinMtPlayerPolicy,
    IMediaTailorCompanionAd,
    MediaTailorCompanionAd,
    MediaTailorPlayerType,
    MtAssetType,
    MtConfiguration,
    MtSessionResponse,
    MtSourceConfig
} from "./MediaTailorTypes";
import {Logger} from "./Logger";
import stringify from "fast-safe-stringify";
import axios from "axios";
import {ArrayUtils} from "bitmovin-player-ui";
import {
    AdAvail,
    BMTAdBreakEvent,
    BMTAdEvent,
    BMTAnalyticsFiredEvent,
    BMTListenerEvent,
    MediaTailorSession,
    MtAd
} from "./MediaTailorSession";

// It is expected that this does not implement all members of the PlayerAPI because they will be added dynamically.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export class InternalBitmovinMtPlayer implements BitmovinMediaTailorAPI {
    private readonly player: PlayerAPI;
    private mtConfig: MtConfiguration;
    private mediaTailorSourceConfig: MtSourceConfig;

    private eventHandlers: { [eventType: string]: PlayerEventCallback[] } = {};
    private suppressedEventsController: EventSuppressController = new EventSuppressController();

    // save playback speed to restore after AdBreak
    private playbackSpeed = 1;
    private isPlaybackFinished = false;
    private playerPolicy: BitmovinMediaTailorPlayerPolicy;
    private cachedSeekTarget: number;
    private adStartedTimestamp: number;
    private _session: MediaTailorSession;

    private lastTimeChangedTime = 0;

    constructor(containerElement: HTMLElement, player: PlayerAPI, mtConfig: MtConfiguration = {}) {
        Logger.log('[BitmovinMediaTailorPlayer] loading');
        this.player = player;
        this.mtConfig = mtConfig;
        this.session = null;
        this.wrapPlayer();
    }

    // Getters/Setters
    get session(): MediaTailorSession | null {
        return this._session;
    }

    set session(value: MediaTailorSession | null) {
        this._session = value;
    }

    //Helpers
    private bindMediaTailorEvent() {
        if (!this.session) {
            return;
        }

        this.session.addListener(BMTListenerEvent.AD_BREAK_START, this.onAdBreakStarted);
        this.session.addListener(BMTListenerEvent.ADVERT_START, this.onAdStarted);
        this.session.addListener(BMTListenerEvent.ADVERT_END, this.onAdFinished);
        this.session.addListener(BMTListenerEvent.AD_BREAK_END, this.onAdBreakFinished);
        this.session.addListener(BMTListenerEvent.AD_MANIFEST_LOADED, this.onAdManifestLoaded);
        this.session.addListener(BMTListenerEvent.ANALYTICS_FIRED, this.onAnalyticsFired);
    }
    private getCurrentAdBreak(): AdAvail | null {
        if (!this.session) {
            return null;
        }

        return this.session.getActiveAdBreak();
    }
    private mapAds(mtAds: MtAd[]): Ad[] {
        let bmAds: Ad[] = [];
        mtAds.forEach(ad => {
            bmAds.push(this.mapAd(ad));
        });
        return bmAds;
    }

    private mapAd(ad: MtAd): LinearAd {
        let bmAd: LinearAd = {
            isLinear: true,
            duration: ad.durationInSeconds,
            id: ad.adId,
            companionAds: this.mapCompanionAds(ad.companionAds),
            height: null,
            width: null,
            data: null,
            mediaFileUrl: ad.mediaFiles[0]?.mediaFilesList[0]?.mediaFileUri,
            verifications: ad.adVerifications,
            extensions: this.mapAdExtensions(ad.extensions),
            clickThroughUrl: ad.clickThroughUrl,
            clickThroughUrlOpened: ad.clickThroughUrlOpened,
            skippableAfter: parseInt(ad.skipOffset),
            uiConfig: {
                requestsUi: true,
            }
        }
        return bmAd;
    }

    private mapAdBreak(adAvail: AdAvail): AdBreak {
        let adBreak: AdBreak = {
            replaceContentDuration: 0,
            ads: this.mapAds(adAvail.ads),
            id: adAvail.availId,
            // -0.001 offset required to not seek to after ad break using default canSeekTo policy
            scheduleTime: this.toMagicTime(adAvail.startTimeInSeconds, 'mapAdBreak') - 0.001,
        }
        return adBreak;
    }

    private mapAdExtensions(extensions: {content?: string, type?: string}[]): VastAdExtension[] {
        let bmExts: VastAdExtension[] = [];
        extensions.forEach(ext => {
            let bmExt: VastAdExtension = {
                attributes: null,
                value: ext.content,
                name: ext.type,
                children: null
            }
            bmExts.push(bmExt);
        })

        return bmExts;
    }

    private mapCompanionAds(companions: IMediaTailorCompanionAd[]): MediaTailorCompanionAd[] {
        let comps: MediaTailorCompanionAd[] = [];
        companions.forEach(companion => {
            comps.push(new MediaTailorCompanionAd(companion));
        })
        return comps;
    }

    private getAdStartTime(ad: MtAd): number {
        if (this.isLive()) {
            return this.adStartedTimestamp || 0;
        }

        return ad.startTimeInSeconds;
    }

    private isAdActive(): boolean {
        if (!this.session) return false;
        return this.session.isAdBreakActive()
    }

    private getCurrentAd(): MtAd {
        if (!this.session) return null;

        return this.session.getActiveAd();
    }

    private toMagicTime(playbackTime: number, issuer:string = null): number {
        if (this.isLive()) return playbackTime;
        if (!this.session) return playbackTime;

        /**
         * Provides a relative content playhead position to the client,
         * discounting the sum of all ad break durations prior to the
         * absolute playhead position provided. This allows the client
         * to return to the same content position if a VOD stream is
         * stopped before playback ends.
         */
        //return toSeconds((this.session as SessionVOD).getContentPositionForPlayhead(toMilliseconds(playbackTime)));
        //return this.player.getCurrentTime();
        return this.session.getContentPositionForPlayhead(playbackTime, issuer);
    }

    private toAbsoluteTime(relativeTime: number): number {
        if (this.mediaTailorSourceConfig.assetType === MtAssetType.VOD) {
            if (!this.session) return relativeTime;

            /**
             * Provides an absolute playhead position to the client
             * calculating the sum of all ad break durations prior to
             * that absolute playhead position plus the relative content
             * playhead position. This allows the client to return to
             * the same content position if a VOD stream is stopped
             * before playback ends.
             */
            return this.session.getPlayheadForContentPosition(relativeTime, "toAbsoluteTime");
        } else {
            return relativeTime;
        }
    }

    private getManifestType(manifestUrl: string): 'dash' | 'hls' | null {
        let url = new URL(manifestUrl);
        if (url.pathname.includes('.m3u')) {
            return 'hls';
        } else if (url.pathname.includes('.mpd')) {
            return 'dash';
        } else {
            return null;
        }
    }

    private async fetchMtSession(source: MtSourceConfig): Promise<MtSessionResponse>{

        if(typeof source.sessionInitUrl === 'string') {
            source.sessionInitUrl = source.sessionInitUrl as string;
        } else {
            return source.sessionInitUrl as MtSessionResponse;
        }

        let postJson = {
            adsParams: {}
        };
        if (source.adsParams) postJson.adsParams = source.adsParams;

        try {
            let response = await axios.post(source.sessionInitUrl, postJson);
            let mtSessionResponse: MtSessionResponse = {
                manifestUrl: new URL(response.data['manifestUrl'], new URL(source.sessionInitUrl)).href,
                trackingUrl: new URL(response.data['trackingUrl'], new URL(source.sessionInitUrl)).href
            }
            Logger.log(mtSessionResponse.manifestUrl);
            return mtSessionResponse;
        } catch(error) {
            let err = new Error("Error getting MediaTailor Session Initialization Response");
            err.stack = error;
            throw err;
        }
    }

    private async fetchMtTracking(mtSessionResponse: MtSessionResponse): Promise<any> {
        try {
            let response = await axios.get(mtSessionResponse.trackingUrl);
            return response.data;
        } catch (error) {
            throw new Error("Unable to retrieve MediaTailor Tracking response");
        }
    }

    private registerPlayerEvents(): void {
        this.player.on(PlayerEvent.Playing, this.onPlaying);
        this.player.on(PlayerEvent.TimeChanged, this.onTimeChanged);
        this.player.on(PlayerEvent.Paused, this.onPause);
        this.player.on(PlayerEvent.Seek, this.onSeek);
        this.player.on(PlayerEvent.Seeked, this.onSeeked);

        this.player.on(PlayerEvent.StallStarted, this.onStallStarted);
        this.player.on(PlayerEvent.StallEnded, this.onStallEnded);

        this.player.on(PlayerEvent.Muted, this.onMuted);
        this.player.on(PlayerEvent.Unmuted, this.onUnmuted);

        // To support ads in live streams we need to track metadata events
        //this.player.on(PlayerEvent.Metadata, this.onMetaData);
    }

    private unregisterPlayerEvents(): void {
        this.player.off(PlayerEvent.Playing, this.onPlaying);
        this.player.off(PlayerEvent.TimeChanged, this.onTimeChanged);
        this.player.off(PlayerEvent.Paused, this.onPause);
        this.player.off(PlayerEvent.Seek, this.onSeek);
        this.player.off(PlayerEvent.Seeked, this.onSeeked);
        this.player.off(PlayerEvent.StallStarted, this.onStallStarted);
        this.player.off(PlayerEvent.StallEnded, this.onStallEnded);

        this.player.on(PlayerEvent.Muted, this.onMuted);
        this.player.on(PlayerEvent.Unmuted, this.onUnmuted);

        // To support ads in live streams we need to track metadata events
        //this.player.off(PlayerEvent.Metadata, this.onMetaData);
    }

    private getCurrentAdDuration(): number {
        if (this.isAdActive()) return this.getAdDuration(this.getCurrentAd());

        return 0;
    }

    private getAdDuration(ad: MtAd): number {
        return ad.durationInSeconds;
    }

    private handleQuartileEvent(adQuartileEventName: string): void {
        const playerEvent: AdQuartileEvent = {
            timestamp: Date.now(),
            type: this.player.exports.PlayerEvent.AdQuartile,
            quartile: this.mapAdQuartile(adQuartileEventName),
        };

        this.fireEvent(playerEvent);
    }

    private mapAdQuartile(quartileEvent: string): AdQuartile {
        switch (quartileEvent) {
            case 'firstQuartile':
                return this.player.exports.AdQuartile.FIRST_QUARTILE;
            case 'midpoint':
                return this.player.exports.AdQuartile.MIDPOINT;
            case 'thirdQuartile':
                return this.player.exports.AdQuartile.THIRD_QUARTILE;
        }
    }

    // Event Listeners

    private onAnalyticsFired = (event: BMTAnalyticsFiredEvent) => {
        if (['firstQuartile', 'midpoint', 'thirdQuartile'].includes(event.call_id)) {
            this.handleQuartileEvent(event.call_id);
        }
    }
    private onAdBreakStarted = (event: BMTAdBreakEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] AD_BREAK_START');
        this.player.setPlaybackSpeed(1);

        const playerEvent: AdBreakEvent = {
            adBreak: this.mapAdBreak(event.adBreak),
            type: PlayerEvent.AdBreakStarted,
            timestamp: Date.now()
        }
        this.fireEvent<AdBreakEvent>(playerEvent);
    };

    private onAdStarted =(event: BMTAdEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] AD_START');
        const isTruexAd = event.ad.adSystem === 'trueX';

        if (isTruexAd) {
            Logger.warn('TrueX is no longer supported, all ads and configuration will be ignored');
        }
        if (this.isLive()) this.adStartedTimestamp = this.player.getCurrentTime();
        const playerEvent: AdEvent = {
            ad: this.mapAd(event.ad),
            type: PlayerEvent.AdStarted,
            timestamp: Date.now(),
        }
        this.fireEvent<AdEvent>(playerEvent);
    }

    private onAdFinished = (event: BMTAdEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] AD_FINISHED');
        const playerEvent: AdEvent = {
            ad: this.mapAd(event.ad),
            type: PlayerEvent.AdFinished,
            timestamp: Date.now(),
        }
        this.fireEvent<AdEvent>(playerEvent);
        this.adStartedTimestamp = null;
    }

    private onAdManifestLoaded = (event: BMTAdBreakEvent) => {
        const playerEvent: AdManifestLoadedEvent = {
            adBreak: null,
            type: PlayerEvent.AdManifestLoaded,
            timestamp: Date.now(),
            adConfig: null,
            downloadTiming: null
        };

        this.fireEvent<AdManifestLoadedEvent>(playerEvent);
    };

    private onAdBreakFinished = (event: BMTAdBreakEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] AD_BREAK_FINISHED');

        const playerEvent: AdBreakEvent = {
            adBreak: {
                replaceContentDuration: 0,
                ads: this.mapAds(event.adBreak.ads),
                id: event.adBreak.availId,
                scheduleTime: event.adBreak.startTimeInSeconds,
            },
            type: PlayerEvent.AdBreakFinished,
            timestamp: Date.now()
        }
        this.fireEvent<AdBreakEvent>(playerEvent);

        if (this.cachedSeekTarget) {
            Logger.log('[BitmovinMediaTailorPlayer] Found cached seek target - seeking there ' + this.cachedSeekTarget)
            this.seek(this.cachedSeekTarget, 'mediatailor-ad-skipping');
            this.cachedSeekTarget = null;
        }

        this.player.setPlaybackSpeed(this.playbackSpeed);
    }

    // Event Registers
    load(source: MtSourceConfig): Promise<void> {
        this.mediaTailorSourceConfig = source;
        return new Promise<void>((resolve, reject) => {
            this.resetState();
            this.registerPlayerEvents();
            this.fetchMtSession(source)
                .then(sessionResponse => {
                    let manifestType = this.getManifestType(sessionResponse.manifestUrl);
                    if (manifestType === null) throw new Error("Unable to determine Manifest Type")
                    const clonedSource: SourceConfig = manifestType === 'hls'
                        ? {
                            ...source,
                            hls: sessionResponse.manifestUrl, // use received url from MediaTailor
                            dash: undefined,
                        }
                        : {
                            ...source,
                            dash: sessionResponse.manifestUrl, // use received url from MediaTailor
                            hls: undefined,
                        };
                    // @ts-ignore
                    clonedSource['sessionInitUrl'] = undefined;

                    // convert start time (relative) to an absolute time
                    if (this.mediaTailorSourceConfig.assetType === MtAssetType.VOD
                    && clonedSource.options
                    && clonedSource.options.startOffset) {
                        clonedSource.options.startOffset = this.toAbsoluteTime(clonedSource.options.startOffset);
                        Logger.log('startOffset adjusted to: ' + clonedSource.options.startOffset);
                    }

                    // Initialize policy
                    if (!this.playerPolicy) {
                        this.playerPolicy = new DefaultBitmovinMtPlayerPolicy(this as any as BitmovinMediaTailorAPI);
                    }
                    Logger.log('Loading Source: ' + stringify(clonedSource));
                    this.player.load(clonedSource)
                        .then(() => {
                            let trackingPromise = this.fetchMtTracking(sessionResponse);
                            trackingPromise.then((tracking) => {
                                this.session = new MediaTailorSession(tracking, this.player, this.playerPolicy);
                                this.bindMediaTailorEvent();
                                this.session.onAdManifestLoaded();
                            })
                            resolve();
                        })
                        .catch(reject);

                })
                .catch((error) => {
                    reject(error);
                })
        });
    }

    off(eventType: PlayerEvent, callback: PlayerEventCallback): void;
    off(eventType: PlayerEvent, callback: PlayerEventCallback): void {
        ArrayUtils.remove(this.eventHandlers[eventType], callback);
    }

    on(eventType: PlayerEvent, callback: PlayerEventCallback): void;
    on(eventType: PlayerEvent, callback: PlayerEventCallback): void {
        // we need to suppress some events because they need to be modified first. so don't add it to the actual player
        const suppressedEventTypes = [
            this.player.exports.PlayerEvent.TimeChanged,
            this.player.exports.PlayerEvent.Paused,
            this.player.exports.PlayerEvent.Seeked,
            this.player.exports.PlayerEvent.Seek,

            // Suppress all ad events
            this.player.exports.PlayerEvent.AdBreakFinished,
            this.player.exports.PlayerEvent.AdBreakStarted,
            this.player.exports.PlayerEvent.AdError,
            this.player.exports.PlayerEvent.AdFinished,
            this.player.exports.PlayerEvent.AdLinearityChanged,
            this.player.exports.PlayerEvent.AdManifestLoaded,
            this.player.exports.PlayerEvent.AdQuartile,
            this.player.exports.PlayerEvent.AdSkipped,
            this.player.exports.PlayerEvent.AdStarted,
        ];

        const event = eventType as PlayerEvent;
        if (!suppressedEventTypes.includes(event)) {
            this.player.on(event, callback);
        }


        if (!this.eventHandlers[eventType]) {
            this.eventHandlers[eventType] = [];
        }
        this.eventHandlers[eventType].push(callback);
    }

    setPolicy(policy: BitmovinMediaTailorPlayerPolicy) {
        this.playerPolicy = policy;
    }

    // Player API Implementations
    get ads(): PlayerAdvertisingAPI {
        return this.advertisingApi;
    }

    getDuration(): number {
        if (!this.session) return 0;

        if (this.isAdActive()) return this.getCurrentAdDuration();

        if(this.isLive()) return this.player.getDuration();

        return this.session.getContentDurationMinusAds();
    }

    private advertisingApi: PlayerAdvertisingAPI = {
        discardAdBreak: (adBreakId: string) => {
            Logger.warn('CSAI is not supported for MediaTailor stream');
            return;
        },

        getActiveAdBreak: () => {
            if (!this.isAdActive()) {
                return undefined;
            }

            return this.mapAdBreak(this.getCurrentAdBreak());
        },

        getActiveAd: () => {
            if (!this.isAdActive()) {
                return undefined;
            }

            return this.mapAd(this.getCurrentAd());
        },

        isLinearAdActive: () => {
            return this.isAdActive();
        },

        list: () => {
            if (!this.session) {
                return [];
            }

            let adAvails: AdAvail[] = this.session.getAllAdBreaks();
            let adBreaks: AdBreak[] = [];
            adAvails.forEach(avail => {
                adBreaks.push(this.mapAdBreak(avail));
            })
            return adBreaks;
        },

        schedule: (adConfig: AdConfig) => {
            return Promise.reject('CSAI is not supported for mediatailor stream');
        },

        skip: () => {
            if (this.isAdActive()) {
                if (this.playerPolicy.canSkip() === 0) {
                    const ad = this.getCurrentAd();
                    const adBreak = this.getCurrentAdBreak();
                    const seekTarget = ad.startTimeInSeconds + ad.durationInSeconds;

                    if (seekTarget >= this.player.getDuration()) {
                        this.isPlaybackFinished = true;
                        this.suppressedEventsController.add(
                            this.player.exports.PlayerEvent.Paused,
                            this.player.exports.PlayerEvent.Seek,
                            this.player.exports.PlayerEvent.Seeked
                        );
                        this.player.pause();
                        this.player.seek(adBreak.startTimeInSeconds - 1); // -1 to be sure to don't have a frame of the ad visible
                        this.fireEvent({
                            timestamp: Date.now(),
                            type: this.player.exports.PlayerEvent.PlaybackFinished,
                        });
                    } else {
                        this.player.seek(seekTarget, 'ad-skip');
                    }

                    // Fire Ad Skipped Event. MediaTailorSession will listen for AdSkipped events and fire 'skip' beacons if present
                    this.fireEvent({
                        timestamp: Date.now(),
                        type: this.player.exports.PlayerEvent.AdSkipped,
                        ad: this.mapAd(ad),
                    } as AdEvent);
                } else {
                    Logger.error("PlayerPolicy does not allow skipping Ad")
                }
            }
            return Promise.resolve();
        },

        getModuleInfo: () => {
            // If no advertising module is provided besides the core (i.e. `ima` or `bitmovin`), everything still works but
            // getting the module info for analytics fails. Adding a fallback for this case.
            const moduleInfo = this.player.ads?.getModuleInfo() || { name: 'advertising', version: this.player.version };
            moduleInfo.name += '-mediatailor-integration';
            return moduleInfo;
        },
    };

    get buffer(): PlayerBufferAPI {
        return this.player.buffer;
    }

    play(issuer?: string): Promise<void> {
        if (this.isPlaybackFinished) {
            this.suppressedEventsController.add(this.player.exports.PlayerEvent.Seek, this.player.exports.PlayerEvent.Seeked);
            this.player.seek(0);
            this.isPlaybackFinished = false;
        }
        Logger.log('Calling BM play()')
        return this.player.play();
    }

    pause(issuer?: string): void {
        if (this.playerPolicy.canPause()) {
            this.player.pause();
        }
    }

    mute(issuer?: string): void {
        if (this.playerPolicy.canMute()) {
            this.player.mute();
        }
    }

    forceSeek(time: number, issuer?: string): boolean {
        return this.player.seek(this.toAbsoluteTime(time), issuer);
    }

    seek(time: number, issuer?: string): boolean {
        // do not use this seek method for seeking within ads (skip) use player.seek(…) instead
        if (!this.playerPolicy.canSeek()) {
            return false;
        }

        const allowedSeekTarget = this.playerPolicy.canSeekTo(time);
        if (allowedSeekTarget !== time) {
            // cache original seek target
            this.cachedSeekTarget = time;
        } else {
            this.cachedSeekTarget = null;
        }
        const magicSeekTarget = this.toAbsoluteTime(allowedSeekTarget);

        Logger.log('Seek: ' + time + ' -> ' + magicSeekTarget);
        return this.player.seek(magicSeekTarget, issuer);
    }

    setPlaybackSpeed(speed: number): void {
        if (!this.playerPolicy.canChangePlaybackSpeed()) {
            return;
        }

        this.playbackSpeed = speed;
        this.player.setPlaybackSpeed(this.playbackSpeed);
    }

    private onPlaying = () => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.PLAYING');
    };

    private onTimeChanged = (event: TimeChangedEvent) => {
        // fire magic time-changed event
        this.fireEvent<TimeChangedEvent>({
            timestamp: Date.now(),
            type: PlayerEvent.TimeChanged,
            time: this.getCurrentTime(),
        });
    };

    getCurrentTime(): number {
        if (this.isAdActive()) {
            // return currentTime in AdBreak
            const currentAdPosition = this.player.getCurrentTime();
            return currentAdPosition - this.getAdStartTime(this.getCurrentAd());
        }
        return this.toMagicTime(this.player.getCurrentTime());
    }

    // Needed in BitmovinMediaTailorPlayerPolicy.ts so keep it here
    isLive(): boolean {
        return this.player.isLive();
    }

    unload(): Promise<void> {
        if (this.isAdActive()) {
            this.ads.skip();
        }
        this.resetState();
        return this.player.unload();
    }

    private onPause = (event: PlaybackEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.PAUSE');
        this.fireEvent(event);
    };

    private onSeek = (event: SeekEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.SEEK');
        this.fireEvent(event);
    };

    private onSeeked = (event: SeekEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.SEEKED');
        this.fireEvent(event);
    };

    private onStallStarted = (event: SeekEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.STALL');
        this.fireEvent(event);
    };

    private onStallEnded = (event: SeekEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - PlayerEvent.STALL_ENDED');
        this.fireEvent(event);
    };

    private onMuted = (event: UserInteractionEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - onVolumeChange(muted=true)');
        this.fireEvent(event);
    };

    private onUnmuted = (event: UserInteractionEvent) => {
        Logger.log('[BitmovinMediaTailorPlayer] - onVolumeChange(muted=false)');
        this.fireEvent(event);
    };

    private resetState(): void {
        // reset all local attributes
        this.unregisterPlayerEvents();
        if (this.session) {
            Logger.log('[BitmovinMediaTailorPlayer] - Stop');
            this.session.shutdown();
            this.session = undefined;
        }

        this.adStartedTimestamp = null;
        this.cachedSeekTarget = null;
    }

    private wrapPlayer(): void {
        // Collect all members of the player (public API methods and properties of the player)
        const members: string[] = [];
        for (const member in this.player) {
            members.push(member);
        }

        // Split the members into methods and properties
        const methods = <any[]>[];
        const properties = <any[]>[];

        for (const member of members) {
            if (typeof (<any>this.player)[member] === 'function') {
                methods.push(member);
            } else {
                properties.push(member);
            }
        }

        const player = this.player;

        // Add function wrappers for all API methods that do nothing but calling the base method on the player
        for (const method of methods) {
            // Only add methods that are not already present
            if (typeof (this as any)[method] !== 'function') {
                (this as any)[method] = function () {
                    return (player as any)[method].apply(player, arguments);
                };
            }
        }

        // Add all public properties of the player to the wrapper
        for (const property of properties) {
            // Get an eventually existing property descriptor to differentiate between plain properties and properties with
            // getters/setters.
            // Only add properties that are not already present
            if (!(this as any)[property]) {
                const propertyDescriptor: PropertyDescriptor =
                    Object.getOwnPropertyDescriptor(this.player, property) ||
                    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this.player), property);

                // If the property has getters/setters, wrap them accordingly...
                if (propertyDescriptor && (propertyDescriptor.get || propertyDescriptor.set)) {
                    Object.defineProperty(this as any, property, {
                        get: () => propertyDescriptor.get.call(this.player),
                        set: (value: any) => propertyDescriptor.set.call(this.player, value),
                        enumerable: true,
                    });
                }
                // ... else just transfer the property to the wrapper
                else {
                    (this as any)[property] = (<any>this.player)[property];
                }
            }
        }
    }

    private fireEvent<E extends PlayerEventBase>(event: E): void {
        if (this.eventHandlers[event.type]) {
            this.eventHandlers[event.type].forEach(
                // Trigger events to the customer application asynchronously using setTimeout(fn, 0).
                (callback: PlayerEventCallback) => setTimeout(() => callback(event), 0),
                this
            );
        }
    }
}

class EventSuppressController {
    private suppressedEvents: PlayerEvent[] = [];

    add(...items: PlayerEvent[]) {
        for (const item of items) {
            if (!this.isSuppressed(item)) {
                this.suppressedEvents.push(item);
            }
        }
    }

    remove(...items: PlayerEvent[]) {
        for (const item of items) {
            ArrayUtils.remove(this.suppressedEvents, item);
        }
    }

    isSuppressed(eventType: PlayerEvent): boolean {
        return this.suppressedEvents.includes(eventType);
    }
}
