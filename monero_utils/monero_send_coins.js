// Copyright (c) 2014-2017, MyMonero.com
// 
// All rights reserved.
// 
// Redistribution and use in source and binary forms, with or without modification, are
// permitted provided that the following conditions are met:
// 
// 1. Redistributions of source code must retain the above copyright notice, this list of
//    conditions and the following disclaimer.
// 
// 2. Redistributions in binary form must reproduce the above copyright notice, this list
//    of conditions and the following disclaimer in the documentation and/or other
//    materials provided with the distribution.
// 
// 3. Neither the name of the copyright holder nor the names of its contributors may be
//    used to endorse or promote products derived from this software without specific
//    prior written permission.
// 
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
// THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
// STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
// THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

const JSBigInt = require('../cryptonote_utils/biginteger').BigInteger // important: grab defined export
const monero_utils = require("./monero_cryptonote_utils_instance");
const axios = require("axios");

var config = {
    apiUrl: "http://127.0.0.1:1984/",
    mainnetExplorerUrl: "https://xmrchain.com/",
    testnetExplorerUrl: "https://testnet.xmrchain.com/",
    stagenetExplorerUrl: "http://162.210.173.150:8083/",
    nettype: 0, /* 0 - MAINNET, 1 - TESTNET, 2 - STAGENET */
    coinUnitPlaces: 12,
    txMinConfirms: 10,         // corresponds to CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE in Monero
    txCoinbaseMinConfirms: 60, // corresponds to CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW in Monero
    coinSymbol: 'XMR',
    openAliasPrefix: "xmr",
    coinName: 'Monero',
    coinUriPrefix: 'monero:',
    addressPrefix: 18,
    integratedAddressPrefix: 19,
    subAddressPrefix: 42,
    addressPrefixTestnet: 53,
    integratedAddressPrefixTestnet: 54,
    subAddressPrefixTestnet: 63,
    addressPrefixStagenet: 24,
    integratedAddressPrefixStagenet: 25,
    subAddressPrefixStagenet: 36,
    feePerKB: new JSBigInt('2000000000'),//20^10 - not used anymore, as fee is dynamic.
    dustThreshold: new JSBigInt('1000000000'),//10^10 used for choosing outputs/change - we decompose all the way down if the receiver wants now regardless of threshold
    txChargeRatio: 0.5,
    defaultMixin: 6, // minimum mixin for hardfork v7 is 6 (ring size 7)
    txChargeAddress: '',
    idleTimeout: 30,
    idleWarningDuration: 20,
    maxBlockNumber: 500000000,
    avgBlockTime: 120,
    debugMode: false
};

// few multiplayers based on uint64_t wallet2::get_fee_multiplier
var fee_multiplayers = [1, 4, 20];

function sendCoins(targets, mixin, payment_id, unspentOutputs, randomOuts_url, txtRecords_data, MyAddress, MyPublicKeys, MySecretKeys, nettype, user_priority) {
    mixin = parseInt(mixin);
    nettype = nettype || 0
    user_priority = user_priority || 2
    priority = user_priority.toString();
    var rct = true; //maybe want to set this later based on inputs (?)
    var realDsts = [];
    for (var i = 0; i < targets.length; ++i) {
        var target = targets[i];
        if (!target.address && !target.amount) {
            continue;
        }
        (function (target) {
            var amount;
            try {
                amount = monero_utils.parseMoney(target.amount);
                target.amount = amount;
            } catch (e) {
                throw ("Failed to parse amount (#" + i + ")");
            }
            if (target.address.indexOf('.') === -1) {
                try {
                    // verify that the address is valid
                    monero_utils.decode_address(target.address, nettype);
                } catch (e) {
                    throw ("Failed to decode address (#" + i + "): " + e);
                }
            } else {
                //support openalias
                var domain = target.address.replace(/@/g, ".");

                var data = txtRecords_data.data;

                var records = data.Answer;
                var oaRecords = [];
                if (data.Answer == undefined) {
                    throw ("Failed to resolve DNS records for '" + domain + "': " + "Unknown error")
                }
                console.log(domain + ": ", data.Answer);
                if (data.dnssec_used) {
                    if (data.secured) {
                        console.log("DNSSEC validation successful");
                    } else {
                        throw ("DNSSEC validation failed for " + domain + ": " + data.dnssec_fail_reason);
                    }
                } else {
                    console.log("DNSSEC Not used");
                }
                for (var j = 0; j < records.length; j++) {
                    var record = records[j].data;
                    if (record.slice(1, 4 + config.openAliasPrefix.length + 2) !== "oa1:" + config.openAliasPrefix + " ") {
                        continue;
                    }
                    console.log("Found OpenAlias record: " + record);
                    oaRecords.push(parseOpenAliasRecord(record));
                }
                if (oaRecords.length === 0) {
                    throw ("No OpenAlias records found for: " + domain);
                }
                if (oaRecords.length !== 1) {
                    throw ("Multiple addresses found for given domain: " + domain);
                }
                console.log("OpenAlias record: ", oaRecords[0]);
                var oaAddress = oaRecords[0].address;
                try {
                    monero_utils.decode_address(oaAddress, nettype);
                    console.log(oaAddress)
                    target.address = oaAddress
                } catch (e) {
                    throw ("Failed to decode OpenAlias address: " + oaRecords[0].address + ": " + e);
                }
            }
        })(target);
    }

    var strpad = function (org_str, padString, length) {   // from http://stackoverflow.com/a/10073737/248823
        var str = org_str;
        while (str.length < length)
            str = padString + str;
        return str;
    };

    // Transaction will need at least 1KB fee (13KB for RingCT)

    var feePerKB = new JSBigInt(config.feePerKB);

    var fee_multiplayer = fee_multiplayers[priority - 1]; // default is 4

    var neededFee = rct ? feePerKB.multiply(13) : feePerKB;
    var totalAmountWithoutFee;
    var unspentOuts;
    var pid_encrypt = false; //don't encrypt payment ID unless we find an integrated one

    var destinations = targets
    console.log(destinations)
    totalAmountWithoutFee = new JSBigInt(0);
    for (var i = 0; i < destinations.length; i++) {
        totalAmountWithoutFee = totalAmountWithoutFee.add(destinations[i].amount);
    }
    realDsts = destinations;
    console.log("Parsed destinations: " + JSON.stringify(realDsts));
    console.log("Total before fee: " + monero_utils.formatMoney(totalAmountWithoutFee));
    console.log(realDsts)
    if (realDsts.length === 0) {
        throw ("You need to enter a valid destination");
    }
    if (payment_id) {
        console.log(payment_id)
        if (payment_id.length <= 64 && /^[0-9a-fA-F]+$/.test(payment_id)) {
            // if payment id is shorter, but has correct number, just
            // pad it to required length with zeros
            payment_id = strpad(payment_id, "0", 64);
        }

        // now double check if ok, when we padded it
        if (payment_id.length !== 64 || !(/^[0-9a-fA-F]{64}$/.test(payment_id))) {
            throw ("The payment ID you've entered is not valid")
        }

    }
    if (realDsts.length === 1) {//multiple destinations aren't supported by MyMonero, but don't include integrated ID anyway (possibly should error in the future)
        var decode_result = monero_utils.decode_address(realDsts[0].address, nettype);
        if (decode_result.intPaymentId && payment_id) {
            throw ("Payment ID field must be blank when using an Integrated Address")
        } else if (decode_result.intPaymentId) {
            payment_id = decode_result.intPaymentId;
            pid_encrypt = true; //encrypt if using an integrated address
        }
    }
    if (totalAmountWithoutFee.compare(0) <= 0) {
        throw ("The amount you've entered is too low");
    }
    console.log("Generating transaction...");
    console.log("Destinations: ");
    // Log destinations to console
    for (var j = 0; j < realDsts.length; j++) {
        console.log(realDsts[j].address + ": " + monero_utils.formatMoneyFull(realDsts[j].amount));
    }

    var unspentOuts = checkUnspentOuts(unspentOutputs.outputs || []);
    var unused_outs = unspentOuts.slice(0);
    var using_outs = [];
    var using_outs_amount = new JSBigInt(0);
    if (unspentOutputs.per_kb_fee) {
        feePerKB = new JSBigInt(unspentOutputs.per_kb_fee);
        neededFee = feePerKB.multiply(13).multiply(fee_multiplayer);
    }
    return transfer()

    function checkUnspentOuts(outputs) {
        for (var i = 0; i < outputs.length; i++) {
            for (var j = 0; outputs[i] && j < outputs[i].spend_key_images.length; j++) {
                var gen_key_img = monero_utils.generate_key_image(outputs[i].tx_pub_key, MySecretKeys.view, MyPublicKeys.spend, MySecretKeys.spend, outputs[i].index);
                var key_img = gen_key_img.key_image
                if (key_img === outputs[i].spend_key_images[j]) {
                    console.log("Output was spent with key image: " + key_img + " amount: " + monero_utils.formatMoneyFull(outputs[i].amount));
                    // Remove output from list
                    outputs.splice(i, 1);
                    if (outputs[i]) {
                        j = outputs[i].spend_key_images.length;
                    }
                    i--;
                } else {
                    console.log("Output used as mixin (" + key_img + "/" + outputs[i].spend_key_images[j] + ")");
                }
            }
        }
        console.log("Unspent outs: " + JSON.stringify(outputs));
        return outputs;
    }

    function random_index(list) {
        return Math.floor(Math.random() * list.length);
    }

    function pop_random_value(list) {
        var idx = random_index(list);
        var val = list[idx];
        list.splice(idx, 1);
        return val;
    }

    function select_outputs(target_amount) {
        console.log("Selecting outputs to use. Current total: " + monero_utils.formatMoney(using_outs_amount) + " target: " + monero_utils.formatMoney(target_amount));
        while (using_outs_amount.compare(target_amount) < 0 && unused_outs.length > 0) {
            var out = pop_random_value(unused_outs);
            if (!rct && out.rct) { continue; } //skip rct outs if not creating rct tx
            using_outs.push(out);
            using_outs_amount = using_outs_amount.add(out.amount);
            console.log("Using output: " + monero_utils.formatMoney(out.amount) + " - " + JSON.stringify(out));
        }
    }

    function transfer() {
        var dsts = realDsts.slice(0);
        // Add fee to total amount
        var totalAmount = totalAmountWithoutFee.add(neededFee);
        console.log("Balance required: " + monero_utils.formatMoneySymbol(totalAmount));

        select_outputs(totalAmount);

        //compute fee as closely as possible before hand
        if (using_outs.length > 1 && rct) {
            var newNeededFee = JSBigInt(Math.ceil(monero_utils.estimateRctSize(using_outs.length, mixin, 2) / 1024)).multiply(feePerKB).multiply(fee_multiplayer);
            totalAmount = totalAmountWithoutFee.add(newNeededFee);
            //add outputs 1 at a time till we either have them all or can meet the fee
            while (using_outs_amount.compare(totalAmount) < 0 && unused_outs.length > 0) {
                var out = pop_random_value(unused_outs);
                using_outs.push(out);
                using_outs_amount = using_outs_amount.add(out.amount);
                console.log("Using output: " + monero_utils.formatMoney(out.amount) + " - " + JSON.stringify(out));
                newNeededFee = JSBigInt(Math.ceil(monero_utils.estimateRctSize(using_outs.length, mixin, 2) / 1024)).multiply(feePerKB).multiply(fee_multiplayer);
                totalAmount = totalAmountWithoutFee.add(newNeededFee);
            }
            console.log("New fee: " + monero_utils.formatMoneySymbol(newNeededFee) + " for " + using_outs.length + " inputs");
            neededFee = newNeededFee;
        }

        if (using_outs_amount.compare(totalAmount) < 0) {
            throw ("Not enough spendable outputs / balance too low (have "
                + monero_utils.formatMoneyFull(using_outs_amount) + " but need "
                + monero_utils.formatMoneyFull(totalAmount)
                + " (estimated fee " + monero_utils.formatMoneyFull(neededFee) + " included)");
        }
        else if (using_outs_amount.compare(totalAmount) > 0) {
            var changeAmount = using_outs_amount.subtract(totalAmount);

            if (!rct) {   //for rct we don't presently care about dustiness
                //do not give ourselves change < dust threshold
                var changeAmountDivRem = changeAmount.divRem(config.dustThreshold);
                if (changeAmountDivRem[1].toString() !== "0") {
                    // add dusty change to fee
                    console.log("Adding change of " + monero_utils.formatMoneyFullSymbol(changeAmountDivRem[1]) + " to transaction fee (below dust threshold)");
                }
                if (changeAmountDivRem[0].toString() !== "0") {
                    // send non-dusty change to our address
                    var usableChange = changeAmountDivRem[0].multiply(config.dustThreshold);
                    console.log("Sending change of " + monero_utils.formatMoneySymbol(usableChange) + " to " + MyAddress);
                    dsts.push({
                        address: MyAddress,
                        amount: usableChange
                    });
                }
            }
            else {
                //add entire change for rct
                console.log("Sending change of " + monero_utils.formatMoneySymbol(changeAmount)
                    + " to " + MyAddress);
                dsts.push({
                    address: MyAddress,
                    amount: changeAmount
                });
            }
        }
        else if (using_outs_amount.compare(totalAmount) === 0 && rct) {
            //create random destination to keep 2 outputs always in case of 0 change
            var fakeAddress = monero_utils.create_address(monero_utils.random_scalar()).public_addr;
            console.log("Sending 0 XMR to a fake address to keep tx uniform (no change exists): " + fakeAddress);
            dsts.push({
                address: fakeAddress,
                amount: 0
            });
        }

        if (mixin > 0) {
            var counts = mixin + 1
            var amounts = [];
            for (var l = 0; l < using_outs.length; l++) {
                amounts.push('"' + (using_outs[l].rct ? "0" : using_outs[l].amount.toString()) + '"');
                //amounts.push("0");
            }
            var dataStringRandomOuts = '{"amounts":[' + amounts + '],"count":' + counts + '}';
            return axios
                .post(randomOuts_url, dataStringRandomOuts)
                .then(function (response) {
                    console.log(response.data);
                    var randomOutputs = response.data;
                    return createTx(randomOutputs.amount_outs);
                })
                .catch(function (error) {
                    throw (error)
                });
        } else if (mixin < 0 || isNaN(mixin)) {
            throw ("Invalid mixin");
        } else { // mixin === 0
            return createTx();
        }

        // Create & serialize transaction
        function createTx(mix_outs) {
            var signed;
            try {
                console.log('Destinations: ');
                monero_utils.printDsts(dsts);
                //need to get viewkey for encrypting here, because of splitting and sorting
                if (pid_encrypt) {
                    var realDestViewKey = monero_utils.decode_address(dsts[0].address, nettype).view;
                }

                var splittedDsts = monero_utils.decompose_tx_destinations(dsts, rct);

                console.log('Decomposed destinations:');

                monero_utils.printDsts(splittedDsts);

                signed = monero_utils.create_transaction(
                    MyPublicKeys,
                    MySecretKeys,
                    splittedDsts, using_outs,
                    mix_outs, mixin, neededFee,
                    payment_id, pid_encrypt,
                    realDestViewKey, 0, rct, nettype);

            } catch (e) {
                throw ("Failed to create transaction: " + e)
            }
            console.log("signed tx: ", JSON.stringify(signed));
            //move some stuff here to normalize rct vs non
            var raw_tx_and_hash = {};
            if (signed.version === 1) {
                raw_tx_and_hash.raw = monero_utils.serialize_tx(signed);
                raw_tx_and_hash.hash = monero_utils.cn_fast_hash(raw_tx);
                raw_tx_and_hash.prvkey = signed.prvkey;
                raw_tx_and_hash.no_outputs = signed.vout.length;
                raw_tx_and_hash.no_inputs = signed.vin.length;
            } else {
                raw_tx_and_hash = monero_utils.serialize_rct_tx_with_hash(signed);
            }
            console.log("raw_tx and hash:");
            console.log(raw_tx_and_hash);
            return (raw_tx_and_hash);
        }
    }
};

function parseOpenAliasRecord(record) {
    var parsed = {};
    if (record.slice(1, 4 + config.openAliasPrefix.length + 2) !== "oa1:" + config.openAliasPrefix + " ") {
        throw ("Invalid OpenAlias prefix");
    }
    function parse_param(name) {
        var pos = record.indexOf(name + "=");
        if (pos === -1) {
            // Record does not contain param
            return undefined;
        }
        pos += name.length + 1;
        var pos2 = record.indexOf(";", pos);
        return record.substr(pos, pos2 - pos);
    }

    parsed.address = parse_param('recipient_address');
    parsed.name = parse_param('recipient_name');
    parsed.description = parse_param('tx_description');
    return parsed;
}


exports.sendCoins = sendCoins