/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import { ExtensionContext } from 'vscode'
import { AwsContext } from '../awsContext'
import { isReleaseVersion, isAutomation } from '../vscode/env'
import { getLogger } from '../logger/logger'
import { MetricDatum } from './clienttelemetry'
import { DefaultTelemetryClient, regionKey } from './telemetryClient'
import { DefaultTelemetryPublisher } from './telemetryPublisher'
import { TelemetryFeedback } from './telemetryClient'
import { TelemetryPublisher } from './telemetryPublisher'
import { accountMetadataKey, AccountStatus, computeRegionKey } from './telemetryClient'
import { MetadataObj, TelemetryLogger, mapMetadata } from './telemetryLogger'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { getClientId, validateMetricEvent } from './util'
import { telemetry, MetricBase } from './telemetry'
import fs from '../fs/fs'
import fsNode from 'fs/promises'
import * as collectionUtil from '../utilities/collectionUtils'
import { ExtensionUse } from '../../auth/utils'

export type TelemetryService = ClassToInterfaceType<DefaultTelemetryService>

// This has obvious overlap with telemetryLogger.ts.
// But that searches for fields by name rather than value.
// TODO: unify these interfaces.
export interface MetricQuery {
    /** Metric name to match against pending items. */
    readonly name: string

    /** Metric data (names and values). */
    readonly metadata: MetadataObj

    /** Exclude metadata items matching these keys. */
    readonly equalityKey?: string[]
}

export class DefaultTelemetryService {
    public static readonly telemetryCognitoIdKey = 'telemetryId'
    public static readonly defaultFlushPeriodMillis = 1000 * 60 * 5 // 5 minutes in milliseconds

    public startTime: Date
    public readonly persistFilePath: string
    private _telemetryEnabled: boolean = false

    private _flushPeriod: number
    private _timer?: NodeJS.Timer
    private publisher?: TelemetryPublisher
    private readonly _eventQueue: MetricDatum[]
    private readonly _telemetryLogger = new TelemetryLogger()
    /**
     * Last metric (if any) loaded from cached telemetry from a previous
     * session.
     *
     * We cannot infer this from "session_start" because there can in theory be
     * multiple "session_start" metrics cached from multiple sessions.
     */
    private _endOfCache: MetricDatum | undefined

    /**
     * Use {@link create}() to create an instance of this class.
     */
    protected constructor(
        private readonly awsContext: AwsContext,
        private readonly computeRegion?: string,
        publisher?: TelemetryPublisher
    ) {
        this.persistFilePath = path.join(globals.context.globalStorageUri.fsPath, 'telemetryCache')

        this.startTime = new globals.clock.Date()

        this._eventQueue = []
        this._flushPeriod = DefaultTelemetryService.defaultFlushPeriodMillis

        if (publisher !== undefined) {
            this.publisher = publisher
        }
    }

    /**
     * This exists since we need to first ensure the global storage
     * path exists before creating the instance.
     */
    static async create(awsContext: AwsContext, computeRegion?: string, publisher?: TelemetryPublisher) {
        await DefaultTelemetryService.ensureGlobalStorageExists(globals.context)
        return new DefaultTelemetryService(awsContext, computeRegion, publisher)
    }

    public get logger(): TelemetryLogger {
        return this._telemetryLogger
    }

    public async start(): Promise<void> {
        // TODO: `readEventsFromCache` should be async
        this._eventQueue.push(...(await DefaultTelemetryService.readEventsFromCache(this.persistFilePath)))
        this._endOfCache = this._eventQueue[this._eventQueue.length - 1]
        telemetry.session_start.emit({
            source: ExtensionUse.instance.sourceForTelemetry(),
        })
        this.startFlushInterval()
    }

    public async shutdown(): Promise<void> {
        this.clearTimer()

        // Only write events to disk at shutdown time if:
        //   1. telemetry is enabled
        //   2. we are not in CI or a test suite run
        if (this.telemetryEnabled && !isAutomation()) {
            const currTime = new globals.clock.Date()
            // This is noisy when running tests in vscode.
            telemetry.session_end.emit({
                result: 'Succeeded',
                duration: currTime.getTime() - this.startTime.getTime(),
            })

            try {
                /**
                 * This function runs in deactivate() so we must use node fs. See the vscode behavior doc for more info.
                 */
                await fsNode.writeFile(this.persistFilePath, JSON.stringify(this._eventQueue))
            } catch {}
        }
    }

    public get telemetryEnabled(): boolean {
        return this._telemetryEnabled
    }
    public async setTelemetryEnabled(value: boolean) {
        if (this._telemetryEnabled !== value) {
            this._telemetryEnabled = value

            // send all the gathered data that the user was opted-in for, prior to disabling
            if (!value) {
                await this._flushRecords()
            }
        }
        getLogger().verbose(`Telemetry is ${value ? 'enabled' : 'disabled'}`)
    }

    private _clientId: string | undefined
    /** Returns the client ID, creating one if it does not exist. */
    public get clientId(): string {
        return (this._clientId ??= getClientId(globals.globalState))
    }

    public get timer(): NodeJS.Timer | undefined {
        return this._timer
    }

    public set flushPeriod(period: number) {
        this._flushPeriod = period
    }

    public async postFeedback(feedback: TelemetryFeedback): Promise<void> {
        if (this.publisher === undefined) {
            await this.createDefaultPublisherAndClient()
        }

        if (this.publisher === undefined) {
            throw new Error('Failed to initialize telemetry publisher')
        }

        return this.publisher.postFeedback(feedback)
    }

    public record(event: MetricDatum, awsContext?: AwsContext): void {
        if (this.telemetryEnabled) {
            // TODO: While this catches cases in code that is tested, untested code will still release incomplete metrics.
            // Consider using custom lint rules to address these cases if possible.
            validateMetricEvent(event, isAutomation())

            const actualAwsContext = awsContext || this.awsContext
            const eventWithCommonMetadata = this.injectCommonMetadata(event, actualAwsContext)
            this._eventQueue.push(eventWithCommonMetadata)
            this._telemetryLogger.log(eventWithCommonMetadata)
        }
    }

    public clearRecords(): void {
        this._eventQueue.length = 0
    }

    /**
     * This ensures the folder, where we will store things like telemetry cache, exists.
     *
     * VSCode provides the URI of the folder, but it is not guaranteed to exist.
     */
    private static async ensureGlobalStorageExists(context: ExtensionContext): Promise<void> {
        if (!fs.existsFile(context.globalStorageUri)) {
            await fs.mkdir(context.globalStorageUri)
        }
    }

    /**
     * Publish metrics to the Telemetry Service. Usually it will automatically flush recent events
     * on a regular interval. This should not be used unless you are interrupting this interval,
     * e.g. via a forced window reload.
     */
    public async flushRecords(): Promise<void> {
        if (this.telemetryEnabled) {
            await this._flushRecords()
        }
    }

    /**
     * @warning DO NOT USE DIRECTLY, use `flushRecords()` instead.
     */
    private async _flushRecords(): Promise<void> {
        if (this.publisher === undefined) {
            await this.createDefaultPublisherAndClient()
        }
        if (this.publisher !== undefined) {
            this.publisher.enqueue(...this._eventQueue)
            await this.publisher.flush()
            this.clearRecords()
        }
    }

    /** Flushes the telemetry records every `_flushPeriod` milliseconds. */
    private startFlushInterval(): void {
        this.clearTimer()
        this._timer = globals.clock.setTimeout(async () => {
            await this.flushRecords()
            // Resets timer after the flush as completed
            this.startFlushInterval()
        }, this._flushPeriod)
    }

    /** Clears the timer used to flush the telemetry records. */
    private clearTimer(): void {
        if (this._timer !== undefined) {
            globals.clock.clearTimeout(this._timer)
            this._timer = undefined
        }
    }

    private async createDefaultPublisher(): Promise<TelemetryPublisher | undefined> {
        try {
            // grab our Cognito identityId
            const poolId = DefaultTelemetryClient.config.identityPool
            const identityMapJson = globals.globalState.tryGet(
                DefaultTelemetryService.telemetryCognitoIdKey,
                String,
                '[]'
            )
            // Maps don't cleanly de/serialize with JSON.parse/stringify so we need to do it ourselves
            const identityMap = new Map<string, string>(JSON.parse(identityMapJson) as Iterable<[string, string]>)
            // convert the value to a map
            const identity = identityMap.get(poolId)

            // if we don't have an identity, get one
            if (!identity) {
                const identityPublisherTuple = await DefaultTelemetryPublisher.fromDefaultIdentityPool(this.clientId)

                // save it
                identityMap.set(poolId, identityPublisherTuple.cognitoIdentityId)
                await globals.globalState.update(
                    DefaultTelemetryService.telemetryCognitoIdKey,
                    JSON.stringify(Array.from(identityMap.entries()))
                )

                // return the publisher
                return identityPublisherTuple.publisher
            } else {
                return DefaultTelemetryPublisher.fromIdentityId(this.clientId, identity)
            }
        } catch (err) {
            getLogger().error(`Got ${err} while initializing telemetry publisher`)
        }
    }

    private async createDefaultPublisherAndClient(): Promise<void> {
        this.publisher = await this.createDefaultPublisher()
        if (this.publisher !== undefined) {
            await this.publisher.init()
        }
    }

    private injectCommonMetadata(event: MetricDatum, awsContext: AwsContext): MetricDatum {
        let accountValue: string | AccountStatus
        // The AWS account ID is not set on session start. This matches JetBrains' functionality.
        if (event.MetricName === 'session_end' || event.MetricName === 'session_start') {
            accountValue = AccountStatus.NotApplicable
        } else {
            const account = awsContext.getCredentialAccountId()
            if (account) {
                const accountIdRegex = /[0-9]{12}/
                if (accountIdRegex.test(account)) {
                    // account is valid
                    accountValue = account
                } else {
                    // account is not valid, we can use any non-12-digit string as our stored value to trigger this.
                    // JetBrains uses this value if you're running a sam local invoke with an invalid profile.
                    // no direct calls to production AWS should ever have this value.
                    accountValue = AccountStatus.Invalid
                }
            } else {
                // user isn't logged in
                accountValue = AccountStatus.NotSet
            }
        }

        const commonMetadata = [{ Key: accountMetadataKey, Value: accountValue }]
        if (this.computeRegion) {
            commonMetadata.push({ Key: computeRegionKey, Value: this.computeRegion })
        }
        if (!event?.Metadata?.some((m: any) => m?.Key === regionKey)) {
            const guessedRegion = globals.regionProvider.guessDefaultRegion()
            commonMetadata.push({ Key: regionKey, Value: guessedRegion ?? AccountStatus.NotSet })
        }

        if (event.Metadata) {
            event.Metadata.push(...commonMetadata)
        } else {
            event.Metadata = commonMetadata
        }

        return event
    }

    private static async readEventsFromCache(cachePath: string): Promise<MetricDatum[]> {
        try {
            if ((await fs.existsFile(cachePath)) === false) {
                getLogger().debug('telemetry cache not found, skipping')

                return []
            }
            const input = JSON.parse(await fs.readFileText(cachePath))
            const events = filterTelemetryCacheEvents(input)

            return events
        } catch (error) {
            getLogger().error(error as Error)

            return []
        }
    }

    /**
     * Only passive telemetry is allowed during startup (except for some known
     * special-cases).
     */
    public assertPassiveTelemetry(didReload: boolean) {
        // Special case: these may be non-passive during a VSCode "reload". #1592
        const maybeActiveOnReload = ['sam_init']
        // Metrics from the previous session can be arbitrary: we can't reason
        // about whether they should be passive/active.
        let readingCache = true

        // Array for..of is in-order:
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
        for (const metric of this._eventQueue) {
            if (readingCache) {
                readingCache = metric !== this._endOfCache
                // Skip cached metrics.
                continue
            }
            if (metric.Passive || (didReload && maybeActiveOnReload.includes(metric.MetricName))) {
                continue
            }
            const msg = `non-passive metric emitted at startup: ${metric.MetricName}`
            if (isReleaseVersion()) {
                getLogger().error(msg)
            } else {
                throw Error(msg)
            }
        }
    }

    /**
     * Queries current pending (not flushed) metrics.
     *
     * @note The underlying metrics queue may be updated or flushed at any time while this iterates.
     */
    public async *findIter(predicate: (m: MetricDatum) => boolean): AsyncIterable<MetricDatum> {
        for (const m of this._eventQueue) {
            if (predicate(m)) {
                yield m
            }
        }
    }

    /**
     * Decides if two metrics are equal, by comparing:
     * - `MetricDatum.MetricName`
     * - `MetricDatum.Metadata` fields specified by `equalityKey`
     *
     * Note: these `MetricDatum` fields are NOT compared:
     * - EpochTimestamp
     * - Unit
     * - Value
     * - Passive
     *
     * @param metric1 Metric query (name, data, and equalityKey)
     * @param metric2 Metric
     *
     */
    public isMetricEqual(metric1: MetricQuery, metric2: MetricDatum): boolean {
        if (metric1.name !== metric2.MetricName) {
            return false
        }
        const equalityKey = metric1.equalityKey ?? metric2.Metadata?.map((o) => o.Value ?? '').filter((o) => !!o) ?? []
        for (const k of equalityKey) {
            // XXX: wrap with String() because findPendingMetric() may cast `MetricBase` to `MetadataObj`.
            // TODO: fix this (use proper types instead of this hack).
            const val1 = String(metric1.metadata[k])
            // const val1 = metric1.Metadata?.find((o) => o.Key === k)?.Value
            const val2 = metric2.Metadata?.find((o) => o.Key === k)?.Value
            if (val1 !== val2) {
                return false
            }
        }
        return true
    }

    /**
     * Searches current pending (not flushed) metrics for the first item "equal to" `metric`.
     *
     * @note The underlying metrics queue may be updated or flushed at any time while this iterates.
     *
     * @param name Metric name (ignored if `metric` is `MetricDatum`; required if `metric` is `MetricBase`)
     * @param metric Metric or metadata
     * @param equalityKey Fields that determine "equality".
     *
     */
    public async findPendingMetric(
        name: string,
        metric: MetricDatum | MetricBase,
        equalityKey: string[]
    ): Promise<MetricDatum | undefined> {
        const metric_ = metric as MetricDatum
        const isData = !metric_.MetricName
        const data = isData ? (metric as MetadataObj) : mapMetadata([])(metric_.Metadata ?? [])
        name = isData ? name : metric_.MetricName
        const query: MetricQuery = {
            name: name,
            metadata: data,
            equalityKey: equalityKey,
        }
        const found = await collectionUtil.first(this.findIter((m) => this.isMetricEqual(query, m)))
        return found
    }
}

export function filterTelemetryCacheEvents(input: any): MetricDatum[] {
    if (!Array.isArray(input)) {
        getLogger().error(`Input into filterTelemetryCacheEvents:\n${input}\nis not an array!`)

        return []
    }
    const arr = input as any[]

    return arr
        .filter((item: any) => {
            // Make sure the item is an object
            if (item !== Object(item)) {
                getLogger().error(`Item in telemetry cache:\n${item}\nis not an object! skipping!`)

                return false
            }

            return true
        })
        .filter((item: any) => {
            // Only accept objects that have the required telemetry data
            if (
                !Object.prototype.hasOwnProperty.call(item, 'Value') ||
                !Object.prototype.hasOwnProperty.call(item, 'MetricName') ||
                !Object.prototype.hasOwnProperty.call(item, 'EpochTimestamp') ||
                !Object.prototype.hasOwnProperty.call(item, 'Unit')
            ) {
                getLogger().warn(`skipping invalid item in telemetry cache: %O\n`, item)

                return false
            }

            if ((item as any)?.Metadata?.some((m: any) => m?.Value === undefined || m.Value === '')) {
                getLogger().warn(`telemetry: skipping cached item with null/empty metadata field:\n${item}`)

                return false
            }

            return true
        })
}
