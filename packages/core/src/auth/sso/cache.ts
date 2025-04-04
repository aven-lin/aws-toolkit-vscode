/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as crypto from 'crypto'
import * as path from 'path'
import { getLogger } from '../../shared/logger/logger'
import fs from '../../shared/fs/fs'
import { createDiskCache, KeyedCache, mapCache } from '../../shared/utilities/cacheUtils'
import { stripUndefined } from '../../shared/utilities/collectionUtils'
import { hasProps, selectFrom } from '../../shared/utilities/tsUtils'
import { SsoToken, ClientRegistration } from './model'
import { DevSettings } from '../../shared/settings'
import { onceChanged } from '../../shared/utilities/functionUtils'
import globals from '../../shared/extensionGlobals'
import { ToolkitError } from '../../shared/errors'

interface RegistrationKey {
    readonly startUrl: string
    readonly region: string
    readonly scopes?: string[]
}

export interface SsoAccess {
    readonly token: SsoToken
    readonly region: string
    readonly startUrl: string
    readonly registration?: ClientRegistration
}

export interface SsoCache {
    readonly token: KeyedCache<SsoAccess>
    readonly registration: KeyedCache<ClientRegistration, RegistrationKey>
}

const defaultCacheDir = () => path.join(fs.getUserHomeDir(), '.aws/sso/cache')
export const getCacheDir = () => DevSettings.instance.get('ssoCacheDirectory', defaultCacheDir())

export function getCache(directory = getCacheDir()): SsoCache {
    return {
        token: getTokenCache(directory),
        registration: getRegistrationCache(directory),
    }
}

export function getCacheFileWatcher(directory = getCacheDir()) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*.json'))
    globals.context.subscriptions.push(watcher)
    return watcher
}

export function getRegistrationCache(directory = getCacheDir()): KeyedCache<ClientRegistration, RegistrationKey> {
    // Compatability for older Toolkit versions (format on disk is unchanged)
    type StoredRegistration = Omit<ClientRegistration, 'expiresAt'> & { readonly expiresAt: string }
    const read = (data: StoredRegistration) => ({ ...data, expiresAt: new Date(data.expiresAt) })
    const write = (data: ClientRegistration) => ({ ...data, expiresAt: data.expiresAt.toISOString() })

    const logger = (message: string) => getLogger().debug('auth: SSO registration cache: %s', message)
    const cache: KeyedCache<StoredRegistration, RegistrationKey> = createDiskCache(
        (registrationKey: RegistrationKey) => getRegistrationCacheFile(directory, registrationKey),
        logger
    )

    return mapCache(cache, read, write)
}

export function getTokenCache(directory = getCacheDir()): KeyedCache<SsoAccess> {
    // Older specs do not store the registration
    type MaybeRegistration = Partial<Omit<ClientRegistration, 'expiresAt'> & { readonly registrationExpiresAt: string }>

    // This is the format used by the SDKs (currently)
    type StoredToken = Omit<SsoToken, 'expiresAt'> &
        MaybeRegistration & {
            readonly startUrl: string
            readonly region: string
            readonly expiresAt: string
        }

    function read(data: StoredToken): SsoAccess {
        // Validate data is not missing. Since the input data is passed directly from whatever is on disk.
        if (!hasProps(data, 'accessToken')) {
            throw new ToolkitError(`SSO cache data looks malformed`)
        }

        const registration = hasProps(data, 'clientId', 'clientSecret', 'registrationExpiresAt')
            ? {
                  ...selectFrom(data, 'clientId', 'clientSecret', 'scopes', 'startUrl'),
                  expiresAt: new Date(data.registrationExpiresAt),
              }
            : undefined

        const token = {
            ...selectFrom(data, 'accessToken', 'refreshToken', 'tokenType'),
            expiresAt: new Date(data.expiresAt),
        }

        stripUndefined(token)

        return {
            token,
            registration,
            ...selectFrom(data, 'region', 'startUrl'),
        }
    }

    function write(data: SsoAccess): StoredToken {
        const registration =
            data.registration !== undefined
                ? selectFrom(data.registration, 'clientId', 'clientSecret', 'scopes')
                : undefined

        return {
            ...registration,
            ...selectFrom(data, 'region', 'startUrl'),
            ...selectFrom(data.token, 'accessToken', 'refreshToken'),
            expiresAt: data.token.expiresAt.toISOString(),
            registrationExpiresAt: data.registration?.expiresAt.toISOString(),
        }
    }

    const logIfChanged = onceChanged((message: string) => getLogger().debug(`SSO token cache: ${message}`))
    const cache = createDiskCache<StoredToken, string>((key: string) => getTokenCacheFile(directory, key), logIfChanged)

    return mapCache(cache, read, write)
}

function getTokenCacheFile(ssoCacheDir: string, key: string): string {
    const encoded = encodeURI(key)
    // Per the spec: 'SSO Login Token Flow' the access token must be
    // cached as the SHA1 hash of the bytes of the UTF-8 encoded
    // startUrl value with ".json" appended to the end. However, the
    // cache key used by the Toolkit is an alternative arbitrary key
    // in most scenarios. This alternative cache key still conforms
    // to the same ${sha1(key)}.json cache location semantics.

    const shasum = crypto.createHash('sha1')
    // Suppress warning because:
    //   1. SHA1 is prescribed by the AWS SSO spec
    //   2. the hashed startUrl or other key value is not a secret
    shasum.update(encoded) // lgtm[js/weak-cryptographic-algorithm]
    const hashedKey = shasum.digest('hex') // lgtm[js/weak-cryptographic-algorithm]

    return path.join(ssoCacheDir, `${hashedKey}.json`)
}

function getRegistrationCacheFile(ssoCacheDir: string, key: RegistrationKey): string {
    const hash = (startUrl: string, scopes: string[]) => {
        const shasum = crypto.createHash('sha256')
        shasum.update(startUrl)
        for (const s of scopes) {
            shasum.update(s)
        }
        return shasum.digest('hex')
    }

    const suffix = `${key.region}${key.scopes && key.scopes.length > 0 ? `-${hash(key.startUrl, key.scopes)}` : ''}`
    return path.join(ssoCacheDir, `aws-toolkit-vscode-client-id-${suffix}.json`)
}
