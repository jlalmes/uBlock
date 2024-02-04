/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* jshint esversion:11 */

'use strict';

/******************************************************************************/

import {
    browser,
    dnr,
    runtime,
    localRead, localWrite,
    sessionRead, sessionWrite,
    adminRead,
    action,
} from './ext.js';

import {
    getRulesetDetails,
    defaultRulesetsFromLanguage,
    enableRulesets,
    getEnabledRulesetsDetails,
    updateDynamicRules,
} from './ruleset-manager.js';

import {
    registerInjectables,
} from './scripting-manager.js';

import {
    getFilteringMode,
    setFilteringMode,
    getDefaultFilteringMode,
    setDefaultFilteringMode,
    getTrustedSites,
    setTrustedSites,
    syncWithBrowserPermissions,
} from './mode-manager.js';

import {
    broadcastMessage,
    ubolLog,
} from './utils.js';

/******************************************************************************/

const rulesetConfig = {
    version: '',
    enabledRulesets: [ 'default' ],
    autoReload: true,
};

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '');

let firstRun = false;
let wakeupRun = false;

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

async function loadRulesetConfig() {
    let data = await sessionRead('rulesetConfig');
    if ( data ) {
        rulesetConfig.version = data.version;
        rulesetConfig.enabledRulesets = data.enabledRulesets;
        rulesetConfig.autoReload = data.autoReload && true || false;
        wakeupRun = true;
        return;
    }
    data = await localRead('rulesetConfig');
    if ( data ) {
        rulesetConfig.version = data.version;
        rulesetConfig.enabledRulesets = data.enabledRulesets;
        rulesetConfig.autoReload = data.autoReload && true || false;
        sessionWrite('rulesetConfig', rulesetConfig);
        return;
    }
    rulesetConfig.enabledRulesets = await defaultRulesetsFromLanguage();
    sessionWrite('rulesetConfig', rulesetConfig);
    localWrite('rulesetConfig', rulesetConfig);
    firstRun = true;
}

async function saveRulesetConfig() {
    sessionWrite('rulesetConfig', rulesetConfig);
    return localWrite('rulesetConfig', rulesetConfig);
}

/******************************************************************************/

async function hasGreatPowers(origin) {
    if ( /^https?:\/\//.test(origin) === false ) { return false; }
    return browser.permissions.contains({
        origins: [ `${origin}/*` ],
    });
}

function hasOmnipotence() {
    return browser.permissions.contains({
        origins: [ '<all_urls>' ],
    });
}

async function onPermissionsRemoved() {
    const beforeMode = await getDefaultFilteringMode();
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return false; }
    const afterMode = await getDefaultFilteringMode();
    if ( beforeMode > 1 && afterMode <= 1 ) {
        updateDynamicRules();
    }
    registerInjectables();
    return true;
}

/******************************************************************************/

function onMessage(request, sender, callback) {

    // Does not require trusted origin.

    switch ( request.what ) {

    case 'insertCSS': {
        const tabId = sender?.tab?.id ?? false;
        const frameId = sender?.frameId ?? false;
        if ( tabId === false || frameId === false ) { return; }
        browser.scripting.insertCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            console.log(reason);
        });
        return false;
    }

    default:
        break;
    }

    // Does require trusted origin.

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
    //   Firefox API does not set `sender.origin`
    if ( sender.origin !== undefined && sender.origin !== UBOL_ORIGIN ) { return; }

    switch ( request.what ) {

    case 'applyRulesets': {
        enableRulesets(request.enabledRulesets).then(( ) => {
            rulesetConfig.enabledRulesets = request.enabledRulesets;
            return saveRulesetConfig();
        }).then(( ) => {
            registerInjectables();
            callback();
            broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
        });
        return true;
    }

    case 'getOptionsPageData': {
        Promise.all([
            getDefaultFilteringMode(),
            getTrustedSites(),
            getRulesetDetails(),
            dnr.getEnabledRulesets(),
        ]).then(results => {
            const [
                defaultFilteringMode,
                trustedSites,
                rulesetDetails,
                enabledRulesets,
            ] = results;
            callback({
                defaultFilteringMode,
                trustedSites: Array.from(trustedSites),
                enabledRulesets,
                maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                rulesetDetails: Array.from(rulesetDetails.values()),
                autoReload: rulesetConfig.autoReload,
                firstRun,
            });
            firstRun = false;
        });
        return true;
    }

    case 'setAutoReload':
        rulesetConfig.autoReload = request.state && true || false;
        saveRulesetConfig().then(( ) => {
            callback();
            broadcastMessage({ autoReload: rulesetConfig.autoReload });
        });
        return true;

    case 'popupPanelData': {
        Promise.all([
            getFilteringMode(request.hostname),
            hasOmnipotence(),
            hasGreatPowers(request.origin),
            getEnabledRulesetsDetails(),
        ]).then(results => {
            callback({
                level: results[0],
                autoReload: rulesetConfig.autoReload,
                hasOmnipotence: results[1],
                hasGreatPowers: results[2],
                rulesetDetails: results[3],
            });
        });
        return true;
    }

    case 'getFilteringMode': {
        getFilteringMode(request.hostname).then(actualLevel => {
            callback(actualLevel);
        });
        return true;
    }

    case 'setFilteringMode': {
        getFilteringMode(request.hostname).then(actualLevel => {
            if ( request.level === actualLevel ) { return actualLevel; }
            return setFilteringMode(request.hostname, request.level);
        }).then(actualLevel => {
            registerInjectables();
            callback(actualLevel);
        });
        return true;
    }

    case 'setDefaultFilteringMode': {
        getDefaultFilteringMode().then(beforeLevel =>
            setDefaultFilteringMode(request.level).then(afterLevel =>
                ({ beforeLevel, afterLevel })
            )
        ).then(({ beforeLevel, afterLevel }) => {
            if ( beforeLevel === 1 || afterLevel === 1 ) {
                updateDynamicRules();
            }
            if ( afterLevel !== beforeLevel ) {
                registerInjectables();
            }
            callback(afterLevel);
        });
        return true;
    }

    case 'setTrustedSites':
        setTrustedSites(request.hostnames).then(( ) => {
            registerInjectables();
            return Promise.all([
                getDefaultFilteringMode(),
                getTrustedSites(),
            ]);
        }).then(results => {
            callback({
                defaultFilteringMode: results[0],
                trustedSites: Array.from(results[1]),
            });
        });
        return true;

    default:
        break;
    }
}

/******************************************************************************/

async function start() {
    await loadRulesetConfig();

    if ( wakeupRun === false ) {
        await enableRulesets(rulesetConfig.enabledRulesets);
    }

    // We need to update the regex rules only when ruleset version changes.
    if ( wakeupRun === false ) {
        const currentVersion = getCurrentVersion();
        if ( currentVersion !== rulesetConfig.version ) {
            ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
            updateDynamicRules().then(( ) => {
                rulesetConfig.version = currentVersion;
                saveRulesetConfig();
            });
        }
    }

    // Permissions may have been removed while the extension was disabled
    const permissionsChanged = await onPermissionsRemoved();

    // Unsure whether the browser remembers correctly registered css/scripts
    // after we quit the browser. For now uBOL will check unconditionally at
    // launch time whether content css/scripts are properly registered.
    if ( wakeupRun === false || permissionsChanged ) {
        registerInjectables();

        const enabledRulesets = await dnr.getEnabledRulesets();
        ubolLog(`Enabled rulesets: ${enabledRulesets}`);

        dnr.getAvailableStaticRuleCount().then(count => {
            ubolLog(`Available static rule count: ${count}`);
        });
    }

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
    //   Firefox API does not support `dnr.setExtensionActionOptions`
    if ( wakeupRun === false && dnr.setExtensionActionOptions ) {
        dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    }

    runtime.onMessage.addListener(onMessage);

    browser.permissions.onRemoved.addListener(
        ( ) => { onPermissionsRemoved(); }
    );

    // if ( firstRun ) {
    //     const disableFirstRunPage = await adminRead('disableFirstRunPage');
    //     if ( disableFirstRunPage !== true ) {
    //         runtime.openOptionsPage();
    //     }
    // }

    if (action.setBadgeBackgroundColor && action.setBadgeTextColor) {
        chrome.action.setBadgeBackgroundColor({ color: [41, 122, 255, 255] });
        chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
    }

    try {
        let installId = await localRead('installId') || crypto.randomUUID();
        const res = await fetch('https://www.adblockify.com/api/v1/check-in', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                installId,
                version: getCurrentVersion(),
                userAgent: navigator.userAgent,
            })
        });
        const body = await res.text();
        let data;
        try {
            data = JSON.parse(body);
        } catch {
            throw new Error(`Invalid JSON: ${body}`);
        }
        if ( data && data.installId ) {
            installId = data.installId;
            await localWrite('installId', installId);
        }
    } catch (cause) {
        console.error(cause);
    }
}

try {
    start();
} catch(reason) {
    console.trace(reason);
}
