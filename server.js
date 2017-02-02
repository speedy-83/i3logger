var express = require('express')
    , logger = require('morgan')
    , url = require('url')
    , querystring = require('querystring')
    , app = express()
    , template = require('jade').compileFile(__dirname + '/source/templates/homepage.jade')
    , request = require('request')
    , schedule = require('node-schedule')
    , sqlite3 = require('sqlite3').verbose()
    , Promise = require('promise')
    , db = new sqlite3.Database('i3logger.db');

app.use(logger('dev'));
app.use(express.static(__dirname + '/static'));

var VIN = 'YOURVIN';
var USERNAME = 'YOURCONNECTEDDRIVEUSERNAME';
var PASSWORD = 'YOURCONNECTEDDRIVEPASSWORD';

db.serialize(function () {
    db.run("CREATE TABLE IF NOT EXISTS vehicledata (time INT, timeText TEXT, timeOfRequest INT, soc REAL, socMax REAL, socPercent REAL, lastUpdateReason TEXT, remainingRange TEXT, chargingTimeRemaining TEXT, km INT)");
});

var j = schedule.scheduleJob('0 */5 * * * *', function () {
    console.log("fetch latest data");
    getVehicleData(function (data) {
        var time = data.attributesMap.updateTime_converted_timestamp;
        var timeText = data.attributesMap.updateTime_converted;
        var lastUpdateReason = data.attributesMap.lastUpdateReason;
        var remainingRange = data.attributesMap.beRemainingRangeElectricKm;
        var chargeTimeRemaining = data.attributesMap.chargingTimeRemaining;
        var km = data.attributesMap.mileage;
        var soc = data.soc;
        var socMax = data.socMax;
        var socPercent = data.attributesMap.soc_hv_percent;
        var timeOfRequest = new Date().getTime();

        db.get('SELECT * FROM vehicledata order by time desc', function result(err, data) {
            if (!data || data.time != time) {
                db.run("INSERT into vehicledata VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",  time, timeText, timeOfRequest, soc, socMax, socPercent, lastUpdateReason, remainingRange, chargeTimeRemaining, km);
                console.log("store new data ", data)
            }  else {
                db.run("UPDATE vehicledata SET timeOfRequest = ? where time = ?",  timeOfRequest, time);
                console.log("do not store identical data, update last record", data)
            }
        });
    });
});

app.get('/', function (req, res, next) {
    try {
        db.all('SELECT * FROM vehicledata order by time desc', function result(err, data) {
            if (data) {
                console.log("calc data");
                for (var i = 0; i < data.length -1; i++) {
                    var lastDataPoint = data[i + 1];
                    var dataPoint = data[i];
                    // console.log("LAST DATA");
                    // console.log(lastDataPoint);
                    // console.log("THIS DATA");
                    // console.log(dataPoint);
                    if (dataPoint.soc < lastDataPoint.soc) {
                        var km = dataPoint.km - lastDataPoint.km;
                        var kwh = lastDataPoint.soc - dataPoint.soc;
                        if (km && kwh) dataPoint.consumption = Math.round(kwh / km * 100 * 10) / 10;
                    } else {
                        var time = dataPoint.time - lastDataPoint.time;
                        var kwh = dataPoint.soc - lastDataPoint.soc;
                        if (time && kwh) {
                            var chargeRate = Math.round((kwh / (time / 1000 / 60 / 60)) * 10) / 10;
                            dataPoint.chargeRate= chargeRate;
                        }

                    }

                }
            }
            // console.log(data);
            if (data && data.timeOfRequest) data.timeOfRequest = new Date(data.timeOfRequest);
            var html = template({
                vehicleData: data
            });
            res.send(html)
        });
    } catch (e) {
        next(e)
    }
});


function getVehicleData(processDataCallback) {
    authenticatedRequest(function (authResult) {
        var vehicleDataPromise = new Promise(function (resolve, reject) {
            request('https://www.bmw-connecteddrive.de/api/vehicle/dynamic/v1/' + VIN + '?offset=-60',
                {
                    'auth': {
                        'bearer': authResult.access_token
                    }
                },
                function (error, response, body) {
                    console.log("getVehicleData statusCode: " + response.statusCode);
                    if (!error && response.statusCode == 200) {
                        resolve(JSON.parse(body));
                    }
                    if (response.statusCode == 401) {
                        authResult = undefined;
                        reject(error);
                    } else {
                        reject(error);
                    }
                });
        });

        var socPromise = new Promise(function (resolve, reject) {
            request('https://www.bmw-connecteddrive.de/api/vehicle/navigation/v1/' + VIN,
                {
                    'auth': {
                        'bearer': authResult.access_token
                    }
                },
                function (error, response, body) {
                    console.log("get SOC statusCode: " + response.statusCode);
                    if (!error && response.statusCode == 200) {
                        resolve(JSON.parse(body));
                    }
                    if (response.statusCode == 401) {
                        authResult = undefined;
                        reject(error);
                    } else {
                        reject(error);
                    }
                });
        });

        Promise.all([vehicleDataPromise, socPromise])
            .then(function (res) {
                processDataCallback(Object.assign(res[0], res[1]));
            })
    });
}

var authResult;

function authenticatedRequest(requestToPerform) {
    console.log(authResult);
    if (authResult && authResult.access_token && authResult.expires > new Date()) {
        console.log("use existing auth data");
        requestToPerform(authResult)
    } else {
        console.log("request new auth data");
        request.post('https://customer.bmwgroup.com/gcdm/oauth/authenticate',
            {
                form: {
                    client_id: 'dbf0a542-ebd1-4ff0-a9a7-55172fbfce35',
                    redirect_uri: 'https://www.bmw-connecteddrive.com/app/default/static/external-dispatch.html',
                    response_type: 'token',
                    username: USERNAME,
                    password: PASSWORD
                }
            }
            , function (error, response, body) {
                console.log("authenticatedRequest statusCode: " + response.statusCode);
                if (!error && response.statusCode == 302) {
                    var authdata = response.headers.location.split('#')[1];
                    console.log('authenticatedRequest authdata: ' + authdata);
                    authResult = querystring.parse(authdata);
                    authResult.expires = new Date(new Date().getTime() + (1000 * parseInt(authResult.expires_in)));
                    requestToPerform(authResult)
                } else {
                    throw "authentication error"
                }
            });
    }
}

app.listen(process.env.PORT || 3000, function () {
    console.log('Listening on http://localhost:' + (process.env.PORT || 3000))
});


/*

 Vehicle Data:
 { attributesMap:
 { updateTime_converted: '20.01.2017 18:01',
 condition_based_services: '00003,OK,2018-12,;00017,OK,2018-12,',
 door_lock_state: 'LOCKED',
 vehicle_tracking: '1',
 Segment_LastTrip_time_segment_end_formatted_time: '08:29',
 lastChargingEndReason: 'CHARGING_GOAL_REACHED',
 door_passenger_front: 'CLOSED',
 check_control_messages: '',
 chargingHVStatus: 'INVALID',
 beMaxRangeElectricMile: '131.0',
 lights_parking: 'OFF',
 beRemainingRangeFuelKm: '0.0',
 connectorStatus: 'DISCONNECTED',
 kombi_current_remaining_range_fuel: '0.0',
 window_passenger_front: 'CLOSED',
 beRemainingRangeElectricMile: '123.0',
 mileage: '1912',
 door_driver_front: 'CLOSED',
 updateTime: '20.01.2017 17:01:23 UTC',
 Segment_LastTrip_time_segment_end: '20.01.2017 08:29:00 UTC',
 remaining_fuel: '0.0',
 updateTime_converted_time: '18:01',
 window_driver_front: 'CLOSED',
 chargeNowAllowed: 'NOT_ALLOWED',
 unitOfCombustionConsumption: 'l/100km',
 beMaxRangeElectric: '212.0',
 soc_hv_percent: '95.8',
 single_immediate_charging: 'isUnused',
 beRemainingRangeElectric: '199.0',
 heading: '17',
 Segment_LastTrip_time_segment_end_formatted: '20.01.2017 08:29',
 updateTime_converted_timestamp: '1484935283000',
 gps_lat: '52.5123',
 lastChargingEndResult: 'SUCCESS',
 trunk_state: 'CLOSED',
 hood_state: 'CLOSED',
 chargingLevelHv: '98.0',
 lastUpdateReason: 'VEHICLE_MOVING',
 beRemainingRangeFuel: '0.0',
 lsc_trigger: 'VEHICLE_MOVING',
 unitOfEnergy: 'kWh',
 Segment_LastTrip_time_segment_end_formatted_date: '20.01.2017',
 prognosisWhileChargingStatus: 'NOT_NEEDED',
 beMaxRangeElectricKm: '212.0',
 unitOfElectricConsumption: 'kWh/100km',
 Segment_LastTrip_ratio_electric_driven_distance: '100',
 head_unit_pu_software: '07/14',
 head_unit: 'NBT',
 chargingSystemStatus: 'NOCHARGING',
 door_driver_rear: 'CLOSED',
 charging_status: 'NOCHARGING',
 beRemainingRangeElectricKm: '199.0',
 beRemainingRangeFuelMile: '0.0',
 gps_lng: '26.623414',
 door_passenger_rear: 'CLOSED',
 updateTime_converted_date: '20.01.2017',
 unitOfLength: 'km',
 chargingLogicCurrentlyActive: 'NOT_CHARGING',
 battery_size_max: '35820' },
 vehicleMessages: { ccmMessages: [], cbsMessages: [ [Object], [Object] ] } }


 * */