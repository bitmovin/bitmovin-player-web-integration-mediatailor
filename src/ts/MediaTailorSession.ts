import {
    BitmovinMediaTailorPlayerPolicy,
    companionAdMetric,
    IAdAvail,
    IAdBreakTrackingEvent,
    IAdIcon,
    IAdVerification,
    IMediaFileItem,
    IMediaTailorCompanionAd,
    IMediaTailorSessionTrackingResponse,
    IMtAd,
    interactiveAdMetric,
    isLinearAdMetric,
    isLinearClickMetric,
    isPlayerOperationMetric,
    ITrackingEvent,
    LinearAdClickMetric,
    LinearAdMetric,
    nonLinearAdMetric,
    PlayerOperationMetric
} from "./MediaTailorTypes";
import {
    AdClickedEvent,
    AdEvent, ErrorEvent,
    PlaybackEvent,
    PlayerAPI,
    PlayerEvent,
    PlayerResizedEvent,
    TimeChangedEvent,
    UserInteractionEvent,
    ViewMode,
    ViewModeChangedEvent
} from "bitmovin-player";
import axios from "axios";
import {Logger} from "./Logger";
import {ArrayUtils} from "bitmovin-player-ui";

export class MediaTailorSession {
    private _trackingResponse: MediaTailorSessionTrackingResponse;
    private player: PlayerAPI;
    private _playerHeight: number;
    private _playerWidth: number;
    private _policy: BitmovinMediaTailorPlayerPolicy;

    private _totalDurationAllAvails: number = undefined;
    private _totalStitchedDuration: number = undefined;
    private _totalDurationMinusAds:number = undefined;
    private _activeAdBreak: AdAvail | null = null;
    private _activeAd: MtAd | null = null;

    private __lastActiveAdEndTime: number = undefined;
    private __lastActiveAdBreakEndTime: number = undefined;

    private isPaused = false;
    private listeners: { [eventType: string]: BMTListenerCallbackFunction[] } = {};

    public static currentSession: MediaTailorSession = undefined;

    constructor(responseData: any, player: PlayerAPI, policy: BitmovinMediaTailorPlayerPolicy) {

        let sessionTrackingResponse: IMediaTailorSessionTrackingResponse = responseData as IMediaTailorSessionTrackingResponse;
        this.trackingResponse = new MediaTailorSessionTrackingResponse(sessionTrackingResponse);
        this.trackingResponse.avails.sort((availA, availB) => availA.startTimeInSeconds - availB.startTimeInSeconds)
        this.player = player;
        this._policy = policy;
        player.on(PlayerEvent.TimeChanged, this.onTimeChanged);
        player.on(PlayerEvent.Paused, this.onPaused);
        player.on(PlayerEvent.Play, this.onPlay);
        player.on(PlayerEvent.Muted, this.onMuted);
        player.on(PlayerEvent.Unmuted, this.onUnMuted);
        player.on(PlayerEvent.PlayerResized, this.onPlayerResize);
        player.on(PlayerEvent.ViewModeChanged, this.onViewModeChanged);
        player.on(PlayerEvent.AdSkipped, this.onAdSkipped);
        player.on(PlayerEvent.AdClicked, this.onAdClicked);
        player.on(PlayerEvent.Error, this.onError);
        player.on(PlayerEvent.AdError, this.onError);
        MediaTailorSession.currentSession = this;
    }

    public shutdown(): void {
        this.trackingResponse.shutdown();
        this.trackingResponse = undefined;
        this._trackingResponse = undefined;
        this.player = undefined;
        this.listeners = undefined;
        this.player = undefined;
        this._activeAd = undefined;
        this._activeAdBreak = undefined;
        this._totalDurationAllAvails = undefined;
        this._totalStitchedDuration = undefined;
        this.__lastActiveAdBreakEndTime = undefined;
        this.__lastActiveAdEndTime = undefined;
        this._policy = undefined;
        MediaTailorSession.currentSession = undefined;
    }

    addListener(event: BMTListenerEvent, callback: BMTListenerCallbackFunction): void {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    removeListener(event: BMTListenerEvent, callback: BMTListenerCallbackFunction): void {
        ArrayUtils.remove((this.listeners)[event], callback);
    }

    get trackingResponse(): MediaTailorSessionTrackingResponse | null {
        return this._trackingResponse
    }

    set trackingResponse(value: MediaTailorSessionTrackingResponse | null) {
        this._trackingResponse = value;
    }

    onTimeChanged = (event: TimeChangedEvent) => {
        this.getActiveAd()?.fireLinearEventBeaconsByTime(event.time); // Called once up-front because 'complete' TrackingEvents will not fire after searching for new Ad

        // Look for new Ad
        if (!this.__lastActiveAdEndTime || (event.time >= this.__lastActiveAdEndTime)) { // Potentially New Ad started
            // fire AdEnd if necessary
            if (this._activeAd && !this._activeAd.adEndEventFired) {
                this._activeAd.adEndEventFired = true;
                this.fireAdFinished(this._activeAd);
                this._activeAd = undefined;
            }

            let possibleAd = this._activeAdBreak? this._activeAdBreak?.ads?.find(ad => event.time >= ad.startTimeInSeconds
                && (event.time <= ad.startTimeInSeconds + ad.durationInSeconds)) : undefined;

            this._activeAd = (possibleAd?.adEndEventFired)? undefined : possibleAd


            if (this._activeAd && !this._activeAd.adStartEventFired){
                this._activeAd.adStartEventFired = true;
                this.fireAdStart(this._activeAd);
            }
            this.__lastActiveAdEndTime = this._activeAd? (this._activeAd.startTimeInSeconds + this._activeAd.durationInSeconds - 0.1) : undefined; // reset lastActiveAdEndTime
        }

        // Look for new AdBreak
        if (!this.__lastActiveAdBreakEndTime || (event.time >= this.__lastActiveAdBreakEndTime)){ // potentially new adbreak started
            // fire AdBreakEnd if necessary
            if(this._activeAdBreak && !this._activeAdBreak.adBreakEndEventFired){
                this._activeAdBreak.adBreakEndEventFired = true;
                this.fireAdBreakFinished(this._activeAdBreak);
                this._activeAdBreak.fireAdBreakEvent("breakEnd");
                this._activeAdBreak = undefined;
            }


            this._activeAdBreak = this.trackingResponse.avails.find(avail => event.time >= avail.startTimeInSeconds
                && (event.time <= avail.startTimeInSeconds + avail.durationInSeconds));

            if (this._activeAdBreak && !this._activeAdBreak.adBreakStartEventFired) {
                this._activeAdBreak.adBreakStartEventFired = true;
                this.fireAdBreakStart(this._activeAdBreak);
                this._activeAdBreak.fireAdBreakEvent("breakStart");
            } else if (this._activeAdBreak && this._activeAdBreak.adBreakEndEventFired) {
                let seekTarget = this._activeAdBreak.startTimeInSeconds + this._activeAdBreak.durationInSeconds;
                this._activeAdBreak = undefined;
                if (this._policy.shouldAutomaticallySkipOverWatchedAdBreaks) this.player.seek(seekTarget);
            }
            this.__lastActiveAdBreakEndTime = this._activeAdBreak? (this._activeAdBreak.startTimeInSeconds + this._activeAdBreak.durationInSeconds - 0.01) : undefined;
        }


        this.getActiveAd()?.fireLinearEventBeaconsByTime(event.time); // Called again because new Ad could be found and therefore new beacons to fire
    }

    private fireAdStart(ad: MtAd) {
        this.emitEvent({
            type: BMTListenerEvent.ADVERT_START,
            ad: ad,
        } as BMTAdEvent)
    }

    private fireAdBreakStart(adBreak: AdAvail){
        this.emitEvent({
            type: BMTListenerEvent.AD_BREAK_START,
            adBreak: adBreak
        } as BMTAdBreakEvent)
    }

    private fireAdBreakFinished(adBreak: AdAvail){
        this.emitEvent({
            type: BMTListenerEvent.AD_BREAK_END,
            adBreak: adBreak
        } as BMTAdBreakEvent)
    }

    private fireAdFinished(ad: MtAd) {
        this.emitEvent({
            type: BMTListenerEvent.ADVERT_END,
            ad: ad,
        } as BMTAdEvent)
    }

    onAdClicked = (event: AdClickedEvent) => { // TODO currently not getting onClick events from BitmovinPlayer for SSAI Ads
        Logger.log(event)
    }

    onPaused = (event: PlaybackEvent) => {
        this.isPaused = true;
        this.getActiveAd()?.firePlayerOperationEventBeacon("pause");
    }

    onPlay = (event: PlaybackEvent) => {
        if(this.isPaused) this.getActiveAd()?.firePlayerOperationEventBeacon("resume");
        this.isPaused = false;
    }

    onMuted = (event: UserInteractionEvent) => {
        this.getActiveAd()?.firePlayerOperationEventBeacon("mute");
    }

    onUnMuted = (event: UserInteractionEvent) => {
        this.getActiveAd()?.firePlayerOperationEventBeacon("unmute");
    }

    onAdSkipped = (event: AdEvent) => {
        this.getActiveAd()?.firePlayerOperationEventBeacon("skip");
    }

    onError = (event: ErrorEvent) => {
        // currently only errorcode '400' - 'General Linear error. Media player is unable to display the Linear Ad' is used
        if (this.getActiveAdBreak()) {
            this.getActiveAdBreak().fireAdBreakEvent("error")
        }
        if (this.getActiveAd()) {
            this.getActiveAd().firePlayerOperationEventBeacon('error')
        }
    }

    onPlayerResize = (event: PlayerResizedEvent) => {
        if (this._playerHeight && this._playerWidth) {
            let newWidth = parseInt(event.width);
            let newHeight = parseInt(event.height);

            if (newHeight < this._playerHeight || newWidth < this._playerWidth) {
                this.getActiveAd()?.firePlayerOperationEventBeacon("playerCollapse");
            } else if (newHeight > this._playerHeight || newWidth > this._playerWidth) {
                this.getActiveAd()?.firePlayerOperationEventBeacon("playerExpand");
            }
        }
        if (!this._playerWidth) this._playerWidth = parseInt(event.width);
        if (!this._playerHeight) this._playerHeight = parseInt(event.height);

    }

    onViewModeChanged = (event: ViewModeChangedEvent) => {
        if (event.to === ViewMode.Fullscreen){
            this.getActiveAd()?.firePlayerOperationEventBeacon("playerExpand");
        } else if (event.from === ViewMode.Fullscreen && (event.to === ViewMode.Inline || event.to === ViewMode.PictureInPicture)) {
            this.getActiveAd()?.firePlayerOperationEventBeacon("playerCollapse");
        }

    }

    public getTotalDurationOfAdAvails(): number {
        if (this._totalDurationAllAvails) {
            return this._totalDurationAllAvails;
        } else {
            let total = 0;
            for (let avail of this.trackingResponse.avails) {
                total = total + avail.durationInSeconds;
            }
            this._totalDurationAllAvails = total;
            return this._totalDurationAllAvails;
        }
    }

    public getContentDurationMinusAds():number {
        if (this._totalDurationMinusAds) {
            return this._totalDurationMinusAds;
        } else {
            let allAdDur = this.getTotalDurationOfAdAvails();
            let contentDur = this.getStitchedContentDuration();
            this._totalDurationMinusAds = contentDur - allAdDur;
            return this._totalDurationMinusAds;;
        }
    }

    public getStitchedContentDuration():number {
        if (this._totalStitchedDuration) {
            return this._totalStitchedDuration;
        } else {
            this._totalStitchedDuration = this.player.getDuration();
            return this._totalStitchedDuration;;
        }
    }

    public getPlayheadForContentPosition(seekTarget: number, issuer:string = null): number {
        let adBreakTime = 0;
        this.trackingResponse.avails.forEach(avail => {
            let adjustedTarget = seekTarget + adBreakTime;
            if (avail.startTimeInSeconds <= adjustedTarget) { // AdBreak has finished 22 <= 13 + 10
                adBreakTime = adBreakTime + avail.durationInSeconds;
            }
        });
        return seekTarget + adBreakTime + 0.001
    }

    public getContentPositionForPlayhead(seekTarget?: number, issuer:string = null): number {
        let timeToUse = (seekTarget !== undefined || seekTarget !== null)?  seekTarget : this.player.getCurrentTime();

        let currentContentOnlyTime = timeToUse;
        this.trackingResponse.avails.forEach(avail => {
            if ((avail.startTimeInSeconds + avail.durationInSeconds) <= timeToUse) { // AdBreak has already finished
                currentContentOnlyTime = currentContentOnlyTime - avail.durationInSeconds;
            } else if (avail.startTimeInSeconds <= timeToUse && (avail.startTimeInSeconds + avail.durationInSeconds) > timeToUse ) { // In an adBreak. return time after ad break finishes
                let secondsOfAdBreakWatchedSoFar = timeToUse - avail.startTimeInSeconds;
                currentContentOnlyTime = currentContentOnlyTime - secondsOfAdBreakWatchedSoFar;
            }
        });
        return (currentContentOnlyTime >= 0)? currentContentOnlyTime: 0;
    }

    public isAdBreakActive(): boolean {
        return this._activeAd? true : false;
    }

    public getActiveAd(): MtAd | undefined {
        return this._activeAd;
    }

    public getActiveAdBreak(): AdAvail | undefined {
        return this._activeAdBreak;
    }

    public getAllAdBreaks(): AdAvail[] {
        return this._trackingResponse.avails;
    }

    public onAdManifestLoaded = () => {
        this.emitEvent({
            type: BMTListenerEvent.AD_MANIFEST_LOADED,
            adBreak: null
        } as BMTAdBreakEvent)
    };

    private emitEvent(event: BMTListenerEventBase) {
        if (this.listeners[event.type]) {
            for (const callback of this.listeners[event.type]) {
                callback(event);
            }
        }
    }

    public onTrackingEvent(type: string) {
        Logger.log('[listener] AnalyticsFired', type);
        const event: BMTAnalyticsFiredEvent = {
            type: BMTListenerEvent.ANALYTICS_FIRED,
            call_id: type
        };
        this.emitEvent(event);
    }
}


export interface BMTAnalyticsFiredEvent extends BMTListenerEventBase {
    call_id: string;
}

export interface BMTAdBreakEvent extends BMTListenerEventBase {
    adBreak: AdAvail;
}

export interface BMTAdEvent extends BMTListenerEventBase {
    ad: MtAd;
}
interface BMTListenerCallbackFunction {
    (event: BMTListenerEventBase): void;
}

interface BMTListenerEventBase {
    type: BMTListenerEvent;
}

export enum BMTListenerEvent {
    AD_BREAK_START = 'AdBreakStarted',
    ADVERT_START = 'AdStarted',
    ADVERT_END = 'AdEnded',
    AD_BREAK_END = 'AdBreakEnded',
    ANALYTICS_FIRED = 'AnalyticsFired',
    AD_MANIFEST_LOADED = 'AdManifestLoaded'
}

class AdBreakTrackingEvent implements IAdBreakTrackingEvent {
    beaconUrls: string[] | null;
    eventType: "breakStart" | "breakEnd" | "error";
    trackingEventFired: boolean;
    trackingEventFireSuccess: boolean

    constructor(event: IAdBreakTrackingEvent) {
        this.beaconUrls = event.beaconUrls;
        this.eventType = event.eventType;
        this.trackingEventFired = false;
        this.trackingEventFireSuccess = undefined;
    }

    public fireAdBreakTrackingEvent(){
        this.trackingEventFired = true;
        this.beaconUrls.forEach(url => {
            axios.get(url)
                .then(r => {
                    this.trackingEventFireSuccess = true;
                    Logger.log(`Successfully fired tracking beacon for TrackingEvent of type ${this.eventType} to url ${url}`);
                })
                .catch(err => {
                    this.trackingEventFireSuccess = false;
                    Logger.error(`Unable to fire Tracking beacon for tracking for url ${url}. Got response code ${err.code} with message ${err.message}`);
                })
                .finally(() => {
                    MediaTailorSession.currentSession.onTrackingEvent(this.eventType);
                });
        });
    }

}

export class TrackingEvent implements ITrackingEvent {
    beaconUrls: string[] | null;
    duration: string | null;
    durationInSeconds: number | null;
    eventId: string | null;
    eventProgramDateTime: string | null;
    eventType: PlayerOperationMetric | LinearAdMetric | LinearAdClickMetric | nonLinearAdMetric | companionAdMetric | interactiveAdMetric;
    offset: string | null;
    startTime: string | null;
    startTimeInSeconds: number | null;
    trackingEventFired: boolean;
    trackingEventFireSuccess: boolean

    constructor(event: ITrackingEvent) {
        this.beaconUrls = event.beaconUrls;
        this.eventType = event.eventType;
        this.duration = event.duration;
        this.durationInSeconds = event.durationInSeconds;
        this.eventId = event.eventId;
        this.eventProgramDateTime = event.eventProgramDateTime;
        this.offset = event.offset;
        this.startTime = event.startTime;
        this.startTimeInSeconds = event.startTimeInSeconds;
        this.trackingEventFired = false;
        this.trackingEventFireSuccess = undefined;
    }

    public fireTrackingEvent(){
        this.trackingEventFired = true;
        this.beaconUrls.forEach(url => {
            axios.get(url)
                .then(r => {
                    this.trackingEventFireSuccess = true;
                    Logger.log(`Successfully fired tracking beacon for TrackingEvent of type ${this.eventType} with ID ${this.eventId} to url ${url}`);
                })
                .catch(err => {
                    this.trackingEventFireSuccess = false;
                    Logger.error(`Unable to fire Tracking beacon for tracking event ${this.eventId} for url ${url}. Got response code ${err.code} with message ${err.message}`);
                })
                .finally(() => {
                    MediaTailorSession.currentSession.onTrackingEvent(this.eventType);
                });
        });
    }
}

export class MtAd implements IMtAd {
    public readonly adId: string;
    public readonly adParameters: string | null;
    public readonly adProgramDateTime: string | null;
    public readonly adSystem: string;
    public readonly adTitle: string;
    public readonly adVerifications: IAdVerification[];
    public readonly companionAds: IMediaTailorCompanionAd[];
    public readonly creativeId: string | null;
    public readonly creativeSequence: string | null;
    public readonly duration: string;
    public readonly durationInSeconds: number;
    public readonly extensions: { content?: string | null; type?: string | null }[];
    public readonly icons: IAdIcon[];
    public readonly mediaFiles: { mediaFilesList: IMediaFileItem[]; mezzanine: string | null }[];
    public readonly skipOffset: string | null;
    public readonly startTime: string;
    public readonly startTimeInSeconds: number;
    public readonly trackingEvents: TrackingEvent[] = [];
    public readonly vastAdId: string | null;
    public clickThroughUrl: string | null = null;
    private clickTrackingUrls: string[] = [];
    private customClickTrackingUrls: string[] = [];
    adStartEventFired = false;
    adEndEventFired = false;
    public clickThroughUrlOpened?: () => void = undefined;

    constructor(ad: IMtAd) {
        this.adId = ad.adId;
        this.adParameters = ad.adParameters;
        this.adProgramDateTime = ad.adProgramDateTime;
        this.adSystem = ad.adSystem;
        this.adTitle = ad.adTitle;
        this.adVerifications = ad.adVerifications; //TODO create implementation for IAdVerification
        this.companionAds = ad.companionAds; //TODO create implementation for IMediaTailorCompanionAd
        this.creativeId = ad.creativeId;
        this.creativeSequence = ad.creativeSequence;
        this.duration = ad.duration;
        this.durationInSeconds = ad.durationInSeconds;
        this.extensions = ad.extensions;
        this.icons = ad.icons; // TODO create implementation for IAdIcon
        this.mediaFiles = ad.mediaFiles; // TODO create implementation for IMediaFileItem
        this.skipOffset = ad.skipOffset;
        this.startTime = ad.startTime;
        this.startTimeInSeconds = ad.startTimeInSeconds;
        this.vastAdId = ad.vastAdId;
        ad.trackingEvents.forEach(event => {
            this.trackingEvents.push(new TrackingEvent(event));
        });
        this.findClickThroughs();
    }

    private findClickThroughs() {
        let clickThrough = this.trackingEvents?.find(trackingEvent => trackingEvent.eventType === "clickThrough");
        if (clickThrough) {
            this.clickThroughUrl = (clickThrough.beaconUrls && clickThrough.beaconUrls.length > 0)? clickThrough.beaconUrls[0] : null;
            if (this.clickThroughUrl) {
                let maybeClickTracking = this.trackingEvents?.filter(trackingEvent => trackingEvent.eventType === "clickTracking");
                maybeClickTracking.forEach(clicktracking => {
                    if (clicktracking.beaconUrls && clicktracking.beaconUrls.length> 0) this.clickTrackingUrls.push(...clicktracking.beaconUrls);
                });

                let maybeCustomClickTracking = this.trackingEvents?.filter(trackingEvent => trackingEvent.eventType === "customClick");
                maybeCustomClickTracking.forEach(customClick => {
                    if(customClick.beaconUrls && customClick.beaconUrls.length > 0) this.customClickTrackingUrls.push(...customClick.beaconUrls)
                })
            }
            this.clickThroughUrlOpened = () => {
                this.fireLinearClickEventBeacon("clickTracking");
            }
        }
    }

    public fireLinearEventBeaconsByTime(time: number) {
        let events = this.trackingEvents.filter(trackingEvent => isLinearAdMetric(trackingEvent.eventType) && !trackingEvent.trackingEventFired)
            .filter(trackingEvent => time >= trackingEvent.startTimeInSeconds && time <= trackingEvent.startTimeInSeconds + 0.3); // Using 0.3 as buffer

        events?.forEach(event => {
            if (event.eventType !== "closeLinear") event.fireTrackingEvent(); //TODO add "closeLinear" and implement it's use
        });

    }

    public fireLinearClickEventBeacon(clickMetric: LinearAdClickMetric) {
        let events = this.trackingEvents.filter(trackingEvent => isLinearClickMetric(trackingEvent.eventType));
        let eventsToFire: TrackingEvent[];
        switch (clickMetric) {
            case "clickThrough":
                break;
            case "customClick":
                eventsToFire = events.filter(trackingEvent => trackingEvent.eventType === "customClick");
                break;
            case "clickTracking":
                eventsToFire = events.filter(trackingEvent => trackingEvent.eventType === "clickTracking");
                break;
        }
        eventsToFire?.forEach(event => {
            event.fireTrackingEvent();
        });
    }

    public firePlayerOperationEventBeacon(playerOperation: PlayerOperationMetric) {
        let playerEvents = this.trackingEvents.filter(trackingEvent => isPlayerOperationMetric(trackingEvent.eventType));
        let eventsToFire: TrackingEvent[];
        switch (playerOperation){
            case "optional":
                break;
            case "mute":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "mute");
                break;
            case "notUsed":
                break;
            case "pause":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "pause");
                break;
            case "playerCollapse":
                break;
            case "playerExpand":
                break;
            case "resume":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "resume");
                break;
            case "rewind":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "rewind");
                break;
            case "skip":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "skip");
                break;
            case "unmute":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "unmute");
                break;
            case "error":
                eventsToFire = playerEvents.filter(trackingEvent => trackingEvent.eventType === "error");
                eventsToFire.forEach(e => {
                    e.beaconUrls.forEach(beacon => {
                        if (beacon) beacon = beacon.replace('[ERRORCODE]', '400')
                    })
                })
        }
        eventsToFire?.forEach(event => {
            event.fireTrackingEvent();
        });
    }

}

export class MediaTailorSessionTrackingResponse implements IMediaTailorSessionTrackingResponse {
    avails: AdAvail[] = [];
    dashAvailabilityStartTime?: string | null;
    hlsAnchorMediaSequenceNumber?: string | null;
    nextToken?: string | null;
    nonLinearAvails?: any[];

    constructor(response: IMediaTailorSessionTrackingResponse) {
        this.dashAvailabilityStartTime = response.dashAvailabilityStartTime;
        this.hlsAnchorMediaSequenceNumber = response.hlsAnchorMediaSequenceNumber;
        this.nextToken = response.nextToken;

        this.nonLinearAvails = response.nonLinearAvails; //TODO create interface and implementation for nonLinearAvails

        response.avails.forEach(avail => {
            this.avails.push(new AdAvail(avail));
        });
    }

    public shutdown() {
        this.avails = undefined;
    }

}

export class AdAvail implements IAdAvail {
    adBreakTrackingEvents: AdBreakTrackingEvent[] = [];
    adMarkerDuration: any;
    ads: MtAd[] | null = [];
    availId: string;
    availProgramDateTime: string | null;
    duration: string;
    durationInSeconds: number;
    meta: any;
    nonLinearAdsList: [];
    startTime: string;
    startTimeInSeconds: number;
    adBreakStartEventFired = false;
    adBreakEndEventFired = false;

    constructor(avail: IAdAvail) {
        this.adMarkerDuration = avail.adMarkerDuration;
        this.availId = avail.availId;
        this.availProgramDateTime = avail.availProgramDateTime;
        this.duration = avail.duration;
        this.durationInSeconds = avail.durationInSeconds;
        this.meta = avail.meta;
        this.startTime = avail.startTime;
        this.startTimeInSeconds = avail.startTimeInSeconds;
        this.nonLinearAdsList = avail.nonLinearAdsList; // TODO create interface and implementation for nonLinearAdsList

        avail.adBreakTrackingEvents.forEach(adAvail => {
            this.adBreakTrackingEvents.push(new AdBreakTrackingEvent(adAvail));
        })

        avail.ads.forEach(ad => {
            this.ads.push(new MtAd(ad));
        })
    }

    public fireAdBreakEvent(clickMetric: 'breakStart' | 'breakEnd' | 'error') {
        let events = this.adBreakTrackingEvents.filter(trackingEvent => ['breakStart', 'breakEnd',  'error'].includes(trackingEvent.eventType));
        let eventsToFire: AdBreakTrackingEvent[];
        switch (clickMetric) {
            case "error":
                eventsToFire = events.filter(trackingEvent => trackingEvent.eventType === "error");
                eventsToFire.forEach(e => {
                    e.beaconUrls.forEach(beacon => {
                        if (beacon) beacon = beacon.replace('[ERRORCODE]', '400')
                    })
                })
                break;
            case "breakEnd":
                eventsToFire = events.filter(trackingEvent => trackingEvent.eventType === "breakEnd");
                break;
            case "breakStart":
                eventsToFire = events.filter(trackingEvent => trackingEvent.eventType === "breakStart");
                break;
        }
        eventsToFire?.forEach(event => {
            event.fireAdBreakTrackingEvent();
        });
    }

}
