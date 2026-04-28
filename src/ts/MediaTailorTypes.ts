import {CompanionAd, LinearAd, SourceConfig} from "bitmovin-player";
import {BitmovinMediaTailorAPI} from "./BitmovinMediaTailorAPI";
import {TrackingEvent} from "./MediaTailorSession";
import axios from "axios";
import {Logger} from "./Logger";

export interface MtSourceConfig extends SourceConfig {
    sessionInitUrl: string | MtSessionResponse;
    adsParams: {[key: string]: string};
    assetType: MtAssetType
}
export enum MtAssetType {
    VOD = "VOD",
    LINEAR = "LINEAR"
}
export interface BitmovinMediaTailorPlayerPolicy {
    canMute(): boolean;

    canSeek(): boolean;

    /**
     * Determine whether the player is permitted to seek to a point in the stream.
     * Based on the provided location, the nearest permissible location is returned which should be
     * used by the player to override the viewers chosen seek location.
     * This provides the ability to prevent skipping over adverts.
     * @param seekTarget
     * @return The closest available seek target. Default start time of last ad which would be skipped.
     */
    canSeekTo(seekTarget: number): number;

    /**
     * @return 0+ if skip is permitted
     * the value is the delay in seconds before skip is permitted, otherwise -1 which means the advert is not skippable
     */
    canSkip(): number;

    shouldAutomaticallySkipOverWatchedAdBreaks: boolean;

    canPause(): boolean;

    canChangePlaybackSpeed(): boolean;
}
export class DefaultBitmovinMtPlayerPolicy implements BitmovinMediaTailorPlayerPolicy {
    private player: BitmovinMediaTailorAPI;

    constructor(player: BitmovinMediaTailorAPI) {
        this.player = player;
    }

    canSeek(): boolean {
        // allow only seeking if no ad is playing
        return !this.player.ads.getActiveAdBreak();
    }

    canSeekTo(seekTarget: number): number {
        const currentTime = this.player.getCurrentTime();
        const adBreaks = this.player.ads.list();

        const skippedAdBreaks = adBreaks.filter((adBreak) => {
            return adBreak.scheduleTime > currentTime && adBreak.scheduleTime < seekTarget;
        });

        if (skippedAdBreaks.length > 0 && !this.player.isAdImmunityActive()) {
            const adBreakToPlay = skippedAdBreaks[skippedAdBreaks.length - 1];
            return adBreakToPlay.scheduleTime;
        }

        return seekTarget;
    }

    canSkip(): number {
        const currentAd = this.player.ads.getActiveAd();
        if (currentAd && currentAd.isLinear && !this.player.isLive()) {
            const currentTime = this.player.getCurrentTime();
            const skippableAfter = (currentAd as LinearAd).skippableAfter;
            if (skippableAfter === undefined || skippableAfter < 0) {
                return -1;
            }
            if (currentTime >= skippableAfter) {
                return 0;
            } else {
                return skippableAfter - currentTime;
            }
        }
        return -1;
    }

    canMute(): boolean {
        return true;
    }

    canPause(): boolean {
        return true;
    }

    canChangePlaybackSpeed(): boolean {
        return !this.player.ads.getActiveAd();
    }

    shouldAutomaticallySkipOverWatchedAdBreaks: boolean = true;
}
export interface AdImmunityConfig {
    /**
     * How long (in seconds) ad immunity lasts after an ad break finishes.
     * During this window the player can seek freely without being trapped at unwatched breaks.
     * Default: 30 seconds.
     */
    duration?: number;
    /**
     * When true, any unwatched ad break the player seeks past during the immunity window is
     * automatically marked as watched, so it will not trap the user on future seeks.
     * Default: true.
     */
    disablePassedAdBreaks?: boolean;
}
export interface MtConfiguration {
    debug?: boolean;
    disableServiceWorker?: boolean;
    disableStrictBreaks?: boolean;
    useTizen?: boolean;
    useWebos?: boolean;
    /**
     * Configures a post-ad-break immunity window during which the user can seek freely.
     * Omit this field (or set it to undefined) to disable ad immunity entirely.
     */
    adImmunity?: AdImmunityConfig;
}
export enum MtAdBreakPosition {
    Unknown = 'unknown',
    PreRoll = 'preroll',
    MidRoll = 'midroll',
    PostRoll = 'postroll',
}
export enum MediaTailorPlayerType {
    Bitmovin,
    BitmovinMediaTailor,
}
export interface MtSessionResponse {
    manifestUrl: string
    trackingUrl: string
}
export interface IAdVerificationExecutableResource {
    apiFramework?: string,
    type?: string,
    uri?: string,
    language?: string
}
export interface IAdVerificationJavaScriptResource {
    apiFramework?: string
    browserOptional?: string
    uri?: string
}
export interface IAdVerificationTrackingEvent {
    event?:adVerificationTrackingEventType
    uri?: string
}
export interface IAdVerificationParameters {
    event?: string
    uri?: string
}
export interface IAdVerification {
    executableResource?: IAdVerificationExecutableResource[]
    javaScriptResource?: IAdVerificationJavaScriptResource[]
    vendor?: string
    trackingEvents?: IAdVerificationTrackingEvent[]
    verificationParameters?: IAdVerificationParameters[]
}
export interface IMediaTailorCompanionAd extends CompanionAd{
    adParameters?: string | null
    altText?: string | null
    attributes?: {
        adSlotId?: string | null
        apiFramework?: string | null
        assetHeight?: string | null
        assetWidth?: string | null
        expandedHeight?: string | null
        expandedWidth?: string | null
        height?: string | null
        id?: string | null
        pxratio?: string | null
        renderingMode?: string | null
        width?: string | null
    }
    companionClickThrough?: string | null
    companionClickTracking?: string | null
    htmlResource?: string | null
    iFrameResource?: string | null
    sequence?: string | null
    staticResource?: string | null
    trackingEvents: {
        eventType: companionAdMetric
        beaconUrls: string[]
    }[]
    fireCompanionAdEvent: (clickMetric: 'creativeView') => void
    fireCompanionClickTrackingEvent: ()=> Promise<number>
}
export class MediaTailorCompanionAd implements IMediaTailorCompanionAd {
    adParameters: string | null;
    altText: string | null;
    attributes: { adSlotId?: string | null; apiFramework?: string | null; assetHeight?: string | null; assetWidth?: string | null; expandedHeight?: string | null; expandedWidth?: string | null; height?: string | null; id?: string | null; pxratio?: string | null; renderingMode?: string | null; width?: string | null };
    companionClickThrough: string | null;
    companionClickTracking: string | null;
    fireCompanionAdEvent: (clickMetric: "creativeView")=> void;
    fireCompanionClickTrackingEvent: ()=> Promise<number>;
    height: number;
    htmlResource: string | null;
    iFrameResource: string | null;
    sequence: string | null;
    staticResource: string | null;
    trackingEvents:{ eventType: companionAdMetric; beaconUrls: string[] }[];
    width: number;

    constructor(companionAd: IMediaTailorCompanionAd) {
        this.adParameters = companionAd.adParameters ?? null;
        this.altText = companionAd.altText ?? null;
        this.attributes = companionAd.attributes ?? {};
        this.companionClickThrough = companionAd.companionClickThrough ?? null;
        this.companionClickTracking = companionAd.companionClickTracking ?? null;
        this.height = parseInt(companionAd.attributes?.height ?? '0');
        this.width = parseInt(companionAd.attributes?.width ?? '0');
        this.htmlResource = companionAd.htmlResource ?? null;
        this.iFrameResource = companionAd.iFrameResource ?? null;
        this.sequence = companionAd.sequence ?? null;
        this.staticResource = companionAd.staticResource ?? null;
        this.trackingEvents = companionAd.trackingEvents;
        this.fireCompanionClickTrackingEvent = async (): Promise<number> => {
            if (this.companionClickTracking && this.companionClickTracking !== '') {
                try {
                    const response = await axios.get(this.companionClickTracking);
                    Logger.log('Successfully fired CompanionAd ClickTrackingEvent');
                    return response.status;
                } catch (err) {
                    const e = err as { code?: number; message?: string };
                    Logger.error(`Unable to fire CompanionAd ClickTrackingEvent. Got response code ${e.code} with message ${e.message}`);
                    return e.code ?? 0;
                }
            }
            return 0;
        };
        this.fireCompanionAdEvent = (clickMetric: 'creativeView') => {
            const events = this.trackingEvents.filter(e => ['creativeView'].includes(e.eventType));
            const eventsToFire: TrackingEvent[] = [];
            switch (clickMetric) {
                case 'creativeView':
                    events.forEach(t => eventsToFire.push(new TrackingEvent(t)));
                    break;
            }
            eventsToFire.forEach(e => e.fireTrackingEvent());
        };
    }
}
export interface IAdIcon {
    attributes: {
        apiFramework?: string | null
        duration?: string | null
        height?: string | null
        offset?: string | null
        program?: string | null
        pxratio?: string | null
        width?: string | null
        xPosition?: string | null
        yPosition?: string | null
    }[]
    dateTime?: string | null
    duration?: string | null
    durationInSeconds?: number | null
    htmlResource?: string | null
    iconClicks?: string | null
    iconClickThrough?: string | null
    iconClickTracking?: { id?: string | null }
    iconViewTracking?: string | null
    id?: string | null
    iconClickFallbackImages: {
        altText?: string | null
        height?: string | null
        width?: string | null
        staticResource?: {
            creativeType?: string | null
            uri?: string | null
        }
    }[]
    iFrameResource?: string | null
    staticResource?: {
        creativeType?: string | null
        uri?: string | null
    }
    startTime?: string | null
    startTimeInSeconds?: number | null
}
export interface ITrackingEvent {
    beaconUrls?: string[] | null
    duration?: string | null
    durationInSeconds?: number | null
    eventId?: string | null
    eventProgramDateTime?: string | null
    eventType: PlayerOperationMetric | LinearAdMetric | LinearAdClickMetric | nonLinearAdMetric | companionAdMetric | interactiveAdMetric
    startTime?: string | null
    startTimeInSeconds?: number | null
    offset?: string | null
    trackingEventFired?: boolean
    trackingEventFireSuccess?: boolean
}
export interface IMediaFileItem {
    apiFramework?: string | null
    delivery?: string | null
    height?: string | null
    maintainAspectRatio?: string | null
    mediaFileUri?: string | null
    mediaType?: string | null
    scalable?: string | null
    width?: string | null
}
export interface IMtAd {
    adId?: string,
    adParameters?: string | null
    adProgramDateTime?: string | null
    adSystem?: string
    adTitle?: string
    adVerifications?: IAdVerification[]
    companionAds?: IMediaTailorCompanionAd[]
    duration: string,
    durationInSeconds: number
    creativeId?: string | null
    creativeSequence?: string | null
    extensions?: {
        content?: string | null
        type?: string | null
    }[]
    icons: IAdIcon[]
    mediaFiles: {
        mediaFilesList: IMediaFileItem[]
        mezzanine: string | null
    }[]
    skipOffset?: string | null
    startTime: string
    startTimeInSeconds: number
    vastAdId?: string | null
    trackingEvents: ITrackingEvent[]
    clickThroughUrlOpened?: () => void | undefined;
}
export interface IAdBreakTrackingEvent {
    eventType: "breakStart" | "breakEnd" | "error"
    beaconUrls?: string[] | null
}
export interface IAdAvail {
    adBreakTrackingEvents: IAdBreakTrackingEvent[]
    adMarkerDuration: any | null
    ads?: IMtAd[] | null
    availId?: string
    availProgramDateTime?: string | null
    duration: string
    durationInSeconds: number
    meta: any | null
    nonLinearAdsList: []
    startTime: string
    startTimeInSeconds: number
}
export interface IMediaTailorSessionTrackingResponse {
    avails?: IAdAvail[] | null
    dashAvailabilityStartTime?: string | null
    hlsAnchorMediaSequenceNumber?: string | null
    nextToken?: string | null
    nonLinearAvails?: any[]
}

// Metric Event Types
const playerOpMetrics = ["mute", "unmute", "pause", "resume", "rewind", "skip", "playerExpand", "playerCollapse", "notUsed", "optional", "error"] as const;
export type PlayerOperationMetric = (typeof playerOpMetrics[number]);
export const isPlayerOperationMetric = (x: any): x is PlayerOperationMetric => playerOpMetrics.includes(x);

const linearAdMetrics = ["loaded", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "otherAdInteraction", "progress", "offset", "closeLinear", "acceptInvitationLinear", "impression"] as const;
export type LinearAdMetric = (typeof linearAdMetrics[number]);
export const isLinearAdMetric = (x: any): x is LinearAdMetric => linearAdMetrics.includes(x);


const linearAdClickMetrics = ["clickThrough", "clickTracking", "customClick"] as const;
export type LinearAdClickMetric = (typeof linearAdClickMetrics[number]);
export const isLinearClickMetric = (x: any):x is LinearAdClickMetric => linearAdClickMetrics.includes(x);

export type nonLinearAdMetric = "creativeView" | "acceptInvitation" | "adExpand" | "adCollapse" | "minimize" | "close" | "overlayViewDuration" | "otherAdInteraction";
export type companionAdMetric = "creativeView";
export type interactiveAdMetric = "interactiveStart";
export type adVerificationTrackingEventType = "verificationNotExecuted";
// End Metric Event Types
