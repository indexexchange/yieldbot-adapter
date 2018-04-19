/**
 * @author:    Partner
 * @license:   UNLICENSED
 *
 * @copyright: Copyright (c) 2017 by Index Exchange. All rights reserved.
 *
 * The information contained within this document is confidential, copyrighted
 * and or a trade secret. No part of this document may be reproduced or
 * distributed in any form or by any means, in whole or in part, without the
 * prior written permission of Index Exchange.
 */

'use strict';

////////////////////////////////////////////////////////////////////////////////
// Dependencies ////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

var Browser = require('browser.js');
var Classify = require('classify.js');
var Constants = require('constants.js');
var Prms = require('prms.js');
var Partner = require('partner.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');
var Whoopsie = require('whoopsie.js');
var EventsService;
var TimerService;
var RenderService;

//? if (DEBUG) {
var ConfigValidators = require('config-validators.js');
var PartnerSpecificValidator = require('yieldbot-htb-validator.js');
var Scribe = require('scribe.js');
//? }

////////////////////////////////////////////////////////////////////////////////
// Main ////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

/**
 * The Yieldbot Module
 *
 * @class
 */
function YieldbotHtb(configs) {

    /* =====================================
     * Data
     * ---------------------------------- */

    /* Private
     * ---------------------------------- */

    /**
     * @private
     * @type {Object}
     */
    var __baseClass;

    /**
     * @private
     * @type {Object}
     */
    var __profile;

    /**
     * Variable to keep track of whether yieldbot.go() has been called.
     * @private
     * @type {Object}
     */
    var __goCalled;

    /**
     * Variable to keep track of whether a request has been timedOut.
     * @private
     * @type {Object}
     */
    var __timedOut;

    /**
     * Variable to keep track of the publisherId.
     * @private
     * @type {string}
     */
    var __publisherId;

    /* =====================================
     * Functions
     * ---------------------------------- */

    /* Helpers
     * ---------------------------------- */

    /**
     * Store demand yieldbot demand and appends any demand into outParcels.
     * @param  {Object} sessionId The current session identifier.
     * @param  {string} returnParcels The parcels that will be returned.
     * @param  {string} outstandingXSlotNames The remaining xSlots.
     */
    function __parseResponse(sessionId, returnParcels, outstandingXSlotNames) {

        /* Signal that partner request was complete */
        EventsService.emit('partner_request_complete', {
            partner: __profile.partnerId,
            status: 'success',
            //? if (DEBUG) {
            parcels: returnParcels
                //? }
        });

        for (var i = 0; i < returnParcels.length; i++) {
            var curReturnParcel = returnParcels[i];
            var htSlotId = curReturnParcel.htSlot.getId();

            /* criteria for your current slot */
            var criteria = window.yieldbot.getSlotCriteria(curReturnParcel.xSlotRef.adSlotId);

            /* Error */
            if (!criteria || !Utilities.isNumeric(criteria.ybot_cpm)) { // jshint ignore: line
                //? if (DEBUG) {
                Scribe.warn('Yieldbot did not return slot criteria for ' + curReturnParcel.xSlotRef.adSlotId);
                //? }

                if (__profile.enabledAnalytics.requestTime) {
                    EventsService.emit('hs_slot_error', {
                        sessionId: sessionId,
                        statsId: __profile.statsId,
                        htSlotId: htSlotId,
                        requestId: curReturnParcel.requestId,
                        xSlotNames: [curReturnParcel.xSlotName]
                    });
                }

                if (outstandingXSlotNames[htSlotId] && outstandingXSlotNames[htSlotId][curReturnParcel.requestId]) {
                    Utilities.arrayDelete(outstandingXSlotNames[htSlotId][curReturnParcel.requestId], curReturnParcel.xSlotName);
                }
                continue;
            }

            /* Yieldbot pass */
            if (criteria.ybot_ad === 'n' || Number(criteria.ybot_cpm) <= 0) { // jshint ignore: line
                //? if (DEBUG) {
                Scribe.info(__profile.partnerId + ' price was zero or did not meet floor for { id: ' + curReturnParcel.xSlotRef.adSlotId + ' }.');
                //? }

                curReturnParcel.pass = true;

                continue;
            }

            /* Headerstats bid */
            if (__profile.enabledAnalytics.requestTime) {

                EventsService.emit('hs_slot_bid', {
                    sessionId: sessionId,
                    statsId: __profile.statsId,
                    htSlotId: htSlotId,
                    requestId: curReturnParcel.requestId,
                    xSlotNames: [curReturnParcel.xSlotName]
                });

                if (outstandingXSlotNames[htSlotId] && outstandingXSlotNames[htSlotId][curReturnParcel.requestId]) {
                    Utilities.arrayDelete(outstandingXSlotNames[htSlotId][curReturnParcel.requestId], curReturnParcel.xSlotName);
                }
            }

            /* Yieldbot bid */
            curReturnParcel.targetingType = 'slot';
            curReturnParcel.targeting = {};

            //? if(FEATURES.GPT_LINE_ITEMS) {
            for (var key in criteria) {
                if (!criteria.hasOwnProperty(key)) {
                    continue;
                }

                var outputKey = key;
                if (__baseClass._configs.targetingKeys.hasOwnProperty(key)) {
                    outputKey = __baseClass._configs.targetingKeys[key];
                }

                if (key === 'ybot_cpm') {
                    curReturnParcel.targeting[outputKey] = [__baseClass._bidTransformers.targeting.apply(criteria[key])];
                } else {
                    curReturnParcel.targeting[outputKey] = [criteria[key]];
                }
            }
            //? }

            //? if(FEATURES.RETURN_CREATIVE) {
            curReturnParcel.adm = '<script type="text/javascript" src="//cdn.yldbt.com/js/yieldbot.intent.js"></script>' +
                '<script type="text/javascript">' +
                'var ybotq = ybotq || [];' +
                'ybotq.push(function() {yieldbot.renderAd(' + criteria.ybot_slot + ':' + criteria.ybot_size + ');});' + // jshint ignore: line
                '</script>';
            //? }

            //? if(FEATURES.RETURN_PRICE) {
            curReturnParcel.price = Number(__baseClass._bidTransformers.price.apply(criteria.ybot_cpm)); // jshint ignore: line
            //? }
        }

        if (__profile.enabledAnalytics.requestTime) {
            __baseClass._emitStatsEvent(sessionId, 'hs_slot_pass', outstandingXSlotNames);
        }
    }

    /**
     * Returns a unique timeout  callback based on the provided sessionId, used by the timer service.
     * @param  {Object} sessionId The current session identifier.
     * @param  {Object} requestId The current request identifier.
     * @param  {Object} returnParcels The returnParcels for this request.
     * @param  {Object} xSlotNames The remaining xSlots.
     * @param  {Object} defer The defer object for this request.
     */
    function __generateTimeoutCallback(sessionId, requestId, returnParcels, xSlotNames, defer) {
        return function () {

            /* If doesnt need to be timed out or already timed out, dont do anything. */
            if (!__timedOut.hasOwnProperty(requestId) || __timedOut[requestId] === true) {
                return;
            }

            __timedOut[requestId] = true;

            if (__profile.enabledAnalytics.requestTime) {
                EventsService.emit('partner_request_complete', {
                    partner: __profile.partnerId,
                    status: 'timeout',
                    //? if (DEBUG) {
                    parcels: returnParcels,
                    //? }
                });

                __baseClass._emitStatsEvent(sessionId, 'hs_slot_timeout', xSlotNames);
            }
            defer.resolve(returnParcels);
        };
    }

    /* Main
     * ---------------------------------- */

    function __sendDemandRequest(sessionId, returnParcels) {

        /* Generate yieldbot slots & xSlotNames that are needed bvased on returnParcels */
        var yieldbotSlots = {};
        var xSlotNames = {};

        for (var j = 0; j < returnParcels.length; j++) {
            var curReturnParcel = returnParcels[j];
            var xSlot = curReturnParcel.xSlotRef;

            yieldbotSlots[xSlot.adSlotId] = xSlot.sizes || [];

            /* Build xSlotNames for headerstats */
            var htSlotId = curReturnParcel.htSlot.getId();

            if (!xSlotNames.hasOwnProperty(htSlotId)) {
                xSlotNames[htSlotId] = {};
            }
            if (!xSlotNames[htSlotId].hasOwnProperty(curReturnParcel.requestId)) {
                xSlotNames[htSlotId][curReturnParcel.requestId] = [];
            }
            xSlotNames[htSlotId][curReturnParcel.requestId].push(curReturnParcel.xSlotName);
        }

        /* Initialize requestId and timedOut variable to keep track of this request */
        var requestId = System.generateUniqueId();
        __timedOut[requestId] = false;

        /* Create a new defer promise */
        var defer = Prms.defer();

        window.ybotq.push(function () {
            /* Check with timer service to see if session is still in progress */
            if (TimerService.getTimerState(sessionId) === TimerService.TimerStates.TERMINATED) {
                return;
            }

            /* If first request, defined yieldbot slots and call yieldbot.go() */
            if (!__goCalled) {
                __goCalled = true;

                /* Initial yieldbot request for new slots. */

                /* Register publisher id */
                window.yieldbot.pub(__publisherId);

                /* Define yieldbot slots if first request */
                for (var adSlotId in yieldbotSlots) {
                    if (yieldbotSlots.hasOwnProperty(adSlotId)) {
                        window.yieldbot.defineSlot(adSlotId, {
                            sizes: yieldbotSlots[adSlotId]
                        });
                    }
                }

                /* Call .go to get new demand */
                window.yieldbot.enableAsync();
                window.yieldbot.go();
            } else {
                /* On subsequent requests, call nextPageView to request new demand for lazy loaded/refreshed slots */
                window.yieldbot.nextPageview(yieldbotSlots);
            }
        });

        /* Emit stat events */
        EventsService.emit('partner_request_sent', {
            partner: __profile.partnerId,
            //? if (DEBUG) {
            parcels: returnParcels
                //? }
        });

        if (__profile.enabledAnalytics.requestTime) {
            __baseClass._emitStatsEvent(sessionId, 'hs_slot_request', xSlotNames);
        }

        /* Add callback to yieldbot queue */
        window.ybotq.push(function () {
            if (TimerService.getTimerState(sessionId) === TimerService.TimerStates.TERMINATED) {
                return defer.resolve([]);
            }

            if (!__timedOut[requestId]) {
                delete __timedOut[requestId];
                __parseResponse(sessionId, returnParcels, xSlotNames);
                defer.resolve(returnParcels);
            }
        });

        /* Generate a timeout function to timeout yieldbot */
        var timeoutCallback = __generateTimeoutCallback(sessionId, requestId, returnParcels, xSlotNames, defer);
        SpaceCamp.services.TimerService.addTimerCallback(sessionId, timeoutCallback);
        if (__baseClass._configs.timeout) {
            setTimeout(timeoutCallback, __baseClass._configs.timeout);
        }

        return defer.promise;
    }

    /* send requests for all slots in inParcels */
    function __retriever(sessionId, inParcels) {
        var returnParcelSets = __baseClass._generateReturnParcels(inParcels);
        var demandRequestPromises = [];

        for (var i = 0; i < returnParcelSets.length; i++) {
            demandRequestPromises.push(__sendDemandRequest(sessionId, returnParcelSets[i]));
        }

        return demandRequestPromises;
    }

    /* =====================================
     * Constructors
     * ---------------------------------- */

    (function __constructor() {
        RenderService = SpaceCamp.services.RenderService;
        TimerService = SpaceCamp.services.TimerService;
        EventsService = SpaceCamp.services.EventsService;

        __profile = {
            partnerId: 'YieldbotHtb',
            namespace: 'YieldbotHtb',
            statsId: 'YBOT',
            version: '2.2.0',
            targetingType: 'slot',
            enabledAnalytics: {
                requestTime: true
            },
            features: {
                demandExpiry: {
                    enabled: false,
                    value: 0
                },
                rateLimiting: {
                    enabled: false,
                    value: 0
                }
            },
            targetingKeys: {
                id: 'ix_ybot_id',
                /* This needs to exist to it can be registered with the render service. */
                ybot_ad: 'ybot_ad', // jshint ignore: line
                ybot_size: 'ybot_size', // jshint ignore: line
                ybot_cpm: 'ybot_cpm', // jshint ignore: line
                ybot_slot: 'ybot_slot' // jshint ignore: line
            },
            bidUnitInCents: 1,
            lineItemType: Constants.LineItemTypes.ID_AND_SIZE,
            callbackType: Partner.CallbackTypes.NONE,
            architecture: Partner.Architectures.FSRA,
            requestType: Partner.RequestTypes.ANY
        };

        //? if (DEBUG) {
        var results = ConfigValidators.partnerBaseConfig(configs) || PartnerSpecificValidator(configs);

        if (results) {
            throw Whoopsie('INVALID_CONFIG', results);
        }
        //? }

        /* Yieldbot library */
        var baseUrl = Browser.getProtocol() + '//cdn.yldbt.com/js/yieldbot.intent.js';

        /* Initialize yieldbot queue */
        window.ybotq = window.ybotq || [];
        __goCalled = false;
        __timedOut = {};

        /* Define yieldbot publisherId & slots */
        var deviceType = SpaceCamp.DeviceTypeChecker.getDeviceType();
        if (!configs.publisherId.hasOwnProperty(deviceType)) {
            throw Whoopsie('INVALID_CONFIG', 'publisherId not found for device type: ' + deviceType);
        }

        __publisherId = configs.publisherId[deviceType];

        __baseClass = Partner(__profile, configs, [baseUrl], {
            retriever: __retriever
        });
    })();

    /* =====================================
     * Public Interface
     * ---------------------------------- */

    var derivedClass = {
        /* Class Information
         * ---------------------------------- */

        //? if (DEBUG) {
        __type__: 'YieldbotHtb',
        //? }

        //? if (TEST) {
        __baseClass: __baseClass,
        //? }

        /* Data
         * ---------------------------------- */

        //? if (TEST) {
        __profile: __profile,
        //? }

        /* Functions
         * ---------------------------------- */

        //? if (TEST) {
        __parseResponse: __parseResponse
            //? }
    };

    return Classify.derive(__baseClass, derivedClass);
}

////////////////////////////////////////////////////////////////////////////////
// Exports /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

module.exports = YieldbotHtb;
