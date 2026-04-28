import {
    PlayerAPI,
    SourceConfig,
} from 'bitmovin-player';
import {BitmovinMediaTailorPlayerPolicy, MediaTailorPlayerType, MtSourceConfig} from "./MediaTailorTypes";

export interface BitmovinMediaTailorAPI extends PlayerAPI {
    load(source: SourceConfig | MtSourceConfig): Promise<void>;
    getCurrentPlayerType(): MediaTailorPlayerType;
    setPolicy(policy: BitmovinMediaTailorPlayerPolicy): void;
    forceSeek(time: number, issuer?: string): boolean;
}

