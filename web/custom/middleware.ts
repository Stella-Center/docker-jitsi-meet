import { IStore } from '../app/types';
import { APP_WILL_NAVIGATE } from '../base/app/actionTypes';
import {
    CONFERENCE_FAILED,
    CONFERENCE_JOINED,
    CONFERENCE_LEFT
} from '../base/conference/actionTypes';
import { isRoomValid } from '../base/conference/functions';
import { CONNECTION_ESTABLISHED, CONNECTION_FAILED } from '../base/connection/actionTypes';
import { hideDialog } from '../base/dialog/actions';
import { isDialogOpen } from '../base/dialog/functions';
import {
    JitsiConferenceErrors,
    JitsiConnectionErrors
} from '../base/lib-jitsi-meet';
import { MEDIA_TYPE } from '../base/media/constants';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { isLocalTrackMuted } from '../base/tracks/functions.any';
import { parseURIString } from '../base/util/uri';
import { openLogoutDialog } from '../settings/actions';

import {
    CANCEL_LOGIN,
    LOGIN,
    LOGOUT,
    STOP_WAIT_FOR_OWNER,
    UPGRADE_ROLE_FINISHED,
    WAIT_FOR_OWNER
} from './actionTypes';

import { PARTICIPANT_ROLE_CHANGED } from '../base/participants/actionTypes';

import {
    disableModeratorLogin,
    enableModeratorLogin,
    hideLoginDialog,
    openLoginDialog,
    openTokenAuthUrl,
    openWaitForOwnerDialog,
    redirectToDefaultLocation,
    setTokenAuthUrlSuccess,
    stopWaitForOwner,
    waitForOwner
} from './actions';

import { LoginDialog, WaitForOwnerDialog } from './components';
import { getTokenAuthUrl, isTokenAuthEnabled } from './functions';
import logger from './logger';

/**
 * Middleware that captures connection or conference failed errors and controls
 * moderator login availability and {@link LoginDialog}/{@link WaitForOwnerDialog}.
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case CANCEL_LOGIN: {
        const { dispatch, getState } = store;
        const state = getState();
        const { thenableWithCancel } = state['features/authentication'];

        thenableWithCancel?.cancel();

        // The LoginDialog can be opened on top of "wait for owner". The app
        // should navigate only if LoginDialog was open without the
        // WaitForOwnerDialog.
        if (!isDialogOpen(store, WaitForOwnerDialog)) {
            if (_isWaitingForOwner(store)) {
                // Instead of hiding show the new one.
                const result = next(action);

                dispatch(openWaitForOwnerDialog());

                return result;
            }

            dispatch(hideLoginDialog());

            const { authRequired, conference } = state['features/base/conference'];
            const { passwordRequired } = state['features/base/connection'];

            // Only end the meeting if we are not already inside and trying to upgrade.
            // NOTE: Despite it's confusing name, `passwordRequired` implies an XMPP
            // connection auth error.
            if ((passwordRequired || authRequired) && !conference) {
                dispatch(redirectToDefaultLocation());
            }
        }
        break;
    }

    case CONFERENCE_FAILED: {
        const { error } = action;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [ _lobbyJid, lobbyWaitingForHost ] = error.params || [];

        // If we got a members-only error but we're NOT waiting for the host anymore,
        // stop the wait-for-owner cycle so the lobby is visible.
        if (error.name === JitsiConferenceErrors.MEMBERS_ONLY_ERROR
            && typeof lobbyWaitingForHost !== 'undefined'
            && !lobbyWaitingForHost) {

            store.dispatch(disableModeratorLogin());
            store.dispatch(stopWaitForOwner());
            break;
        }

        let recoverable;

        if (error.name === JitsiConferenceErrors.AUTHENTICATION_REQUIRED
            || (error.name === JitsiConferenceErrors.MEMBERS_ONLY_ERROR && lobbyWaitingForHost)) {
            if (typeof error.recoverable === 'undefined') {
                error.recoverable = true;
            }
            recoverable = error.recoverable;
        }

        if (error.name === JitsiConferenceErrors.MEMBERS_ONLY_ERROR && lobbyWaitingForHost) {
            // Waiting in the "moderator login" state (members-only, host not here yet).
            if (recoverable) {
                store.dispatch(enableModeratorLogin());
            } else {
                store.dispatch(disableModeratorLogin());
            }
        } else if (error.name === JitsiConferenceErrors.AUTHENTICATION_REQUIRED) {
            // Classic "wait for owner" flow.
            if (recoverable) {
                store.dispatch(waitForOwner());
            } else {
                store.dispatch(stopWaitForOwner());
            }
        }

        break;
    }

    case CONFERENCE_JOINED: {
        const result = next(action);
        const state = store.getState();

        const payload = _decodeJwtPayload(state);

        // ✅ Use ONLY the JWT flag (what Django set), not live role
        const isModeratorFromToken =
            payload?.context?.user?.moderator === true
            || payload?.context?.user?.moderator === 'true'
            || payload?.context?.user?.moderator === 1
            || payload?.context?.user?.moderator === '1';

        const client = payload?.redirect_url;
        const provider = payload?.redirect_url_provider;

        const finalUrl = (isModeratorFromToken ? provider : client) || client || provider;

        if (typeof window !== 'undefined') {
            try {
                if (client) localStorage.setItem('jitsi.redirect.client', client);
                if (provider) localStorage.setItem('jitsi.redirect.provider', provider);
                localStorage.setItem('jitsiIsModerator', isModeratorFromToken ? '1' : '0');
                if (finalUrl) localStorage.setItem('jitsi.redirect.final', finalUrl);
            } catch {}
        }

        return result;
    }

    case PARTICIPANT_ROLE_CHANGED: {
        // Let reducers update role first.
        const result = next(action);

        const state = store.getState();

        // Keep moderator status fresh (role can change after join)
        _persistIsModerator(state);

        // Recompute final redirect choice using latest moderator status
        _recomputeFinalRedirectFromStoredTargets();

        return result;
    }

    case CONFERENCE_LEFT: {
        const finalUrl = _getFinalRedirectUrl();

        // Let reducers + other middleware do teardown/navigation first
        const result = next(action);

        store.dispatch(disableModeratorLogin());
        store.dispatch(stopWaitForOwner());

        if (finalUrl && typeof window !== 'undefined') {
            // Give Jitsi time to finish its own route changes.
            setTimeout(() => {
                try {
                    const target = new URL(finalUrl, window.location.origin);
                    const navWindow: any = (window.top && window.top !== window) ? window.top : window;
                    navWindow.location.replace(target.toString());
                } catch {
                    try {
                        window.location.replace(finalUrl);
                    } catch {}
                } finally {
                    _clearRedirectTargets();
                }
            }, 600);
        } else {
            _clearRedirectTargets();
        }

        return result;
    }

    case CONNECTION_ESTABLISHED:
        store.dispatch(hideLoginDialog());
        break;

    case CONNECTION_FAILED: {
        const { error } = action;
        const state = store.getState();
        const { jwt } = state['features/base/jwt'];

        if (error
                && error.name === JitsiConnectionErrors.PASSWORD_REQUIRED
                && typeof error.recoverable === 'undefined'
                && !jwt) {
            error.recoverable = true;

            _handleLogin(store);
        }

        break;
    }

    case LOGIN:
        _handleLogin(store);
        break;

    case LOGOUT:
        _handleLogout(store);
        break;

    case APP_WILL_NAVIGATE: {
        const { dispatch, getState } = store;
        const state = getState();
        const config = state['features/base/config'];
        const room = state['features/base/conference'].room;

        if (isRoomValid(room)
            && config.tokenAuthUrl && config.tokenAuthUrlAutoRedirect
            && state['features/authentication'].tokenAuthUrlSuccessful
            && !state['features/base/jwt'].jwt) {
            dispatch(setTokenAuthUrlSuccess(false));
        }

        break;
    }

    case STOP_WAIT_FOR_OWNER:
        _clearExistingWaitForOwnerTimeout(store);
        store.dispatch(hideDialog('WaitForOwnerDialog', WaitForOwnerDialog));
        break;

    case UPGRADE_ROLE_FINISHED: {
        const { error, progress } = action;

        if (!error && progress === 1) {
            store.dispatch(hideLoginDialog());
        }
        break;
    }

    case WAIT_FOR_OWNER: {
        _clearExistingWaitForOwnerTimeout(store);

        const { handler, timeoutMs }: { handler: () => void; timeoutMs: number; } = action;
        action.waitForOwnerTimeoutID = setTimeout(handler, timeoutMs);

        isDialogOpen(store, LoginDialog) || store.dispatch(openWaitForOwnerDialog());
        break;
    }
    }

    return next(action);
});

/**
 * Will clear the wait for conference owner timeout handler if any is currently set.
 */
function _clearExistingWaitForOwnerTimeout({ getState }: IStore) {
    const { waitForOwnerTimeoutID } = getState()['features/authentication'];
    waitForOwnerTimeoutID && clearTimeout(waitForOwnerTimeoutID);
}

/**
 * Checks if the cyclic "wait for conference owner" task is currently scheduled.
 */
function _isWaitingForOwner({ getState }: IStore) {
    return Boolean(getState()['features/authentication'].waitForOwnerTimeoutID);
}

/**
 * Checks if the cyclic "wait for moderator" task is currently scheduled.
 */
function _isWaitingForModerator({ getState }: IStore) {
    return getState()['features/authentication'].showModeratorLogin;
}

/**
 * Handles login challenge. Opens login dialog or redirects to token auth URL.
 */
function _handleLogin({ dispatch, getState }: IStore) {
    const state = getState();
    const config = state['features/base/config'];
    const room = state['features/base/conference'].room;
    const { locationURL = { href: '' } as URL } = state['features/base/connection'];
    const { tenant } = parseURIString(locationURL.href) || {};
    const { enabled: audioOnlyEnabled } = state['features/base/audio-only'];
    const audioMuted = isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.AUDIO);
    const videoMuted = isLocalTrackMuted(state['features/base/tracks'], MEDIA_TYPE.VIDEO);

    if (!room) {
        logger.warn('Cannot handle login, room is undefined!');
        return;
    }

    if (!isTokenAuthEnabled(config)) {
        dispatch(openLoginDialog());
        return;
    }

    getTokenAuthUrl(
        config,
        locationURL,
        {
            audioMuted,
            audioOnlyEnabled,
            skipPrejoin: true,
            videoMuted
        },
        room,
        tenant
    )
        .then((tokenAuthServiceUrl: string | undefined) => {
            if (!tokenAuthServiceUrl) {
                logger.warn('Cannot handle login, token service URL is not set');
                return;
            }

            return dispatch(openTokenAuthUrl(tokenAuthServiceUrl));
        });
}

/**
 * Handles logout challenge. Opens logout dialog and hangs up the conference.
 */
function _handleLogout({ dispatch, getState }: IStore) {
    const state = getState();
    const { conference } = state['features/base/conference'];

    if (!conference) {
        return;
    }

    dispatch(openLogoutDialog());
}

/* =======================================================================================
 *  Redirect + Moderator persistence (Client vs Provider)
 * =======================================================================================
 */

const IS_MODERATOR_STORAGE_KEY = 'jitsiIsModerator';
const REDIRECT_CLIENT_KEY = 'jitsi.redirect.client';
const REDIRECT_PROVIDER_KEY = 'jitsi.redirect.provider';
const REDIRECT_FINAL_KEY = 'jitsi.redirect.final';

function _getIsModeratorFromState(state: any) {
    const local = state?.['features/base/participants']?.local;

    // In Jitsi Meet, local.role is typically 'moderator' or 'participant'
    if (local?.role) {
        return local.role === 'moderator';
    }

    return false;
}

function _persistIsModerator(state: any) {
    const isModerator = _getIsModeratorFromState(state);

    if (typeof window !== 'undefined') {
        try {
            window.localStorage.setItem(IS_MODERATOR_STORAGE_KEY, isModerator ? '1' : '0');
        } catch {}
    }

    return isModerator;
}

function _getIsModeratorStored(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(IS_MODERATOR_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function _decodeJwtPayload(state: any): any | undefined {
    const jwt = state?.['features/base/jwt']?.jwt;
    if (!jwt) return;

    const parts = jwt.split('.');
    if (parts.length < 2) return;

    try {
        const b64Url = parts[1];
        const b64 = b64Url.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

        const json = decodeURIComponent(
            atob(padded)
                .split('')
                .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                .join('')
        );

        return JSON.parse(json);
    } catch {
        return;
    }
}

function _persistRedirectTargets(state: any) {
    if (typeof window === 'undefined') return;

    const payload = _decodeJwtPayload(state);
    if (!payload) return;

    // Your JWT fields:
    // - redirect_url (client)
    // - redirect_url_provider (provider/moderator)
    const client = payload?.redirect_url;
    const provider = payload?.redirect_url_provider;

    // Prefer moderator from live redux role; fallback to token flag if role isn't ready yet
    const modFromRole = _getIsModeratorFromState(state);
    const modFromToken =
        payload?.context?.user?.moderator === true
        || payload?.context?.user?.moderator === 'true'
        || payload?.context?.user?.moderator === 1
        || payload?.context?.user?.moderator === '1';

    const isModerator = modFromRole || modFromToken;

    try {
        if (client) window.localStorage.setItem(REDIRECT_CLIENT_KEY, client);
        if (provider) window.localStorage.setItem(REDIRECT_PROVIDER_KEY, provider);

        window.localStorage.setItem(IS_MODERATOR_STORAGE_KEY, isModerator ? '1' : '0');

        const finalUrl = _chooseFinalRedirect(isModerator, client, provider);
        if (finalUrl) window.localStorage.setItem(REDIRECT_FINAL_KEY, finalUrl);
    } catch {}
}

function _chooseFinalRedirect(isModerator: boolean, client?: string, provider?: string): string | undefined {
    // Rule:
    // - moderator => provider
    // - non-moderator => client
    // fall back to whichever exists
    return (isModerator ? provider : client) || client || provider;
}

function _recomputeFinalRedirectFromStoredTargets() {
    if (typeof window === 'undefined') return;

    try {
        const client = window.localStorage.getItem(REDIRECT_CLIENT_KEY) || undefined;
        const provider = window.localStorage.getItem(REDIRECT_PROVIDER_KEY) || undefined;
        const isModerator = _getIsModeratorStored();

        const finalUrl = _chooseFinalRedirect(isModerator, client, provider);
        if (finalUrl) {
            window.localStorage.setItem(REDIRECT_FINAL_KEY, finalUrl);
        }
    } catch {}
}

function _getFinalRedirectUrl(): string | undefined {
    if (typeof window === 'undefined') return;
    try {
        return window.localStorage.getItem(REDIRECT_FINAL_KEY) || undefined;
    } catch {
        return;
    }
}

function _clearRedirectTargets() {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(REDIRECT_FINAL_KEY);
        window.localStorage.removeItem(REDIRECT_CLIENT_KEY);
        window.localStorage.removeItem(REDIRECT_PROVIDER_KEY);
        // (optional) keep moderator flag, or clear it:
        // window.localStorage.removeItem(IS_MODERATOR_STORAGE_KEY);
    } catch {}
}