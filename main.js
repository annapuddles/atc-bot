/* ATC bot bridge between Corrade and GridTalkie. */

const mqtt = require('mqtt')
const winston = require('winston')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { XMLParser } = require('fast-xml-parser')
const yaml = require('yamljs')
const qs = require('qs')

/* Read settings from config.yml */
const config = yaml.load('config.yml')

/* Pattern to identify the channel, handle and text of GridTalkie messages:
 *
 * {#<channel>} <handle>: <message>
 *
 */
const gtMessagePattern = /^{#(?<channel>[^}]+)} (?<handle>[^:]+): (?<message>.*)$/g

/* Create a regexp using a standard ATC message format:
 *
 * <ICAO>, <callsign>, <request>
 *
 * */
function standardATCPattern(keywords) {
	return new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*(?:\\b${keywords}\\b).*$`, 'gi')
}

/* ATC message patterns.
 *
 * Simple messages can use the standardATCPattern to match specific keywords in
 * the request.
 *
 * More complex messages will need to be done as a custom regex.
 */
const flightPlanPattern = standardATCPattern('flight ?plan')
const squawkRequestPattern = standardATCPattern('flight ?following')
const radioCheckPattern = standardATCPattern('radio ?(?:check|test)')
const windCheckPattern = standardATCPattern('wind ?check')
const startPattern = standardATCPattern('start ?(?:up)?')
const takeOffPattern = standardATCPattern('tak(?:e|ing) ?off|depart(?:ure)?')
const landingPattern = standardATCPattern('land(?:ing)?')
const weatherCheckPattern = standardATCPattern('weather')
const altimeterPattern = standardATCPattern('altimeter')
const temperatureDewpointPattern = standardATCPattern('temperature|dew ?point')
const visibilityPattern = standardATCPattern('visibility')
const pushbackPattern = standardATCPattern('push ?back')
const taxiPattern = standardATCPattern('taxi(?:ing)?')
const taxiRunwayPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*\\b(?:taxi(?:ing)?)\\b.*\\brunway (?<runway>[0-9a-z]+ ?(?:left|right|center)?)\\b.*$`, 'gi')
const takeOffHelipadPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*\\b(?:tak(?:e|ing) ?off|depart(?:ure)?)\\b.*\\bhelipad (?<helipad>[0-9a-z]+)\\b.*$`, 'gi')
const takeOffRunwayPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*\\b(?:tak(?:e|ing) ?off|depart(?:ure)?)\\b.*\\brunway (?<runway>[0-9a-z]+ ?(?:left|right|center)?)\\b.*$`, 'gi')
const landingHelipadPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*\\bland(?:ing)?\\b.*\\bhelipad (?<helipad>[0-9a-z]+)\\b.*$`, 'gi')
const landingRunwayPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*\\bland(?:ing)?\\b.*\\brunway (?<runway>[0-9a-z]+ ?(?:left|right|center)?)\\b.*$`, 'gi')
const approachPattern = standardATCPattern('approach|eta')
const otherCallsignPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(?<callsign>.*),.*$`, 'gi')
const otherPattern = new RegExp(`^${config.atc.prefix}.*$`, 'gi')

/* Create a logger instance to log messages to console and a log file. */
const logger = winston.createLogger({
	format: winston.format.combine(
			winston.format.timestamp({
				format: 'YYYY-MM-DD HH:mm:ss'
			}),
			winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
		),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({
			filename: path.join(path.dirname(fs.realpathSync(__filename)), config.logs.main)
		})
	]
})

/* Timestamp format in Second Life Time (SLT). */
const timestampInSLT = () => {
	return new Date().toLocaleString('sv', {
		timeZone: 'America/Los_Angeles'
	})
}

/* Create logger to log only the transcript of GridTalkie messages. */
const transcript = winston.createLogger({
	format: winston.format.combine(
			winston.format.timestamp({
				format: timestampInSLT
			}),
			winston.format.printf(info => `${info.timestamp} ${info.message}`)
		),
	transports: [
		new winston.transports.File({
			filename: path.join(path.dirname(fs.realpathSync(__filename)), config.logs.transcript)
		})
	]
})

/**
 * Generates a padded 4-digit code using the min and max limits
 * defined for the active region in config.yml.
 */
function generateConfiguredSquawk() {
    const activeRegion = config.squawk?.current_region;
    const regionSettings = config.squawk?.regions?.[activeRegion];

    const min = regionSettings ? parseInt(regionSettings.min) : 1;
    const max = regionSettings ? parseInt(regionSettings.max) : 660;

    const randomNum = Math.floor(Math.random() * (max - min + 1)) + min;
    return String(randomNum).padStart(4, '0');
}

/* Execute a RegExp pattern disregarding any state. */
function execPattern(pattern, text) {
	pattern.lastIndex = 0
	return pattern.exec(text)
}

/* The current weather information from Shergood, or null if no weather info
 * has been retrieved yet.
 */
let metar = null

/* Shergood METAR regex pattern */
const metarPattern = /^(?<icao>[A-Z0-9]+) (?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})Z AUTO (?<hdg>\d{3})(?<spd>\d{2})KT (?<vis>\d+)SM ?(?<precip>-RA|RA|\+RA|-SN|SN|\+SN)? (?<type>CLR|FEW|SCT|BKN|OVC)(?<ceil>\d{3}|\/\/\/) (?<temp>M?\d{2})\/(?<dew>M?\d{2}) A(?<alt>\d{4}) RMK AO2$/i

/* Parse a METAR temperature value to an integer. */
function parseMetarTemp(raw) {
	if (raw.substring(0, 1) === 'M') {
		return parseInt(raw.substring(1)) * -1
	} else {
		return parseInt(raw)
	}
}

/* Parse METAR altimeter value to decimal string. */
function parseMetarAlt(raw) {
	return raw.substring(0, 2) + '.' + raw.substring(2, 4)
}

/* Parse METAR string into an object. */
function parseMetar(raw) {
	const result = execPattern(metarPattern, raw)

	if (result === null) {
		logger.error(`Invalid METAR: ${raw}`)
		return null
	}

	return {
		icao: result.groups.icao,
		time: {
			day: result.groups.day,
			hour: result.groups.hour,
			minute: result.groups.minute
		},
		wind: {
			heading: result.groups.hdg,
			speed: parseInt(result.groups.spd)
		},
		visibility: parseInt(result.groups.vis),
		precipitation: result.groups.precip,
		clouds: {
			type: result.groups.type,
			ceiling: parseInt(result.groups.ceil) * 100
		},
		temperature: parseMetarTemp(result.groups.temp),
		dewpoint: parseMetarTemp(result.groups.dew),
		altimeter: parseMetarAlt(result.groups.alt)
	}
}

/* Fetch and parse METAR data from Shergood. */
function fetchMetar() {
	const options = {
		hostname: 'shergoodaviation.com',
		port: 443,
		path: '/ajax/ajax-misc.php',
		method: 'POST',
		headers: {
			'Content-type': 'application/x-www-form-urlencoded'
		}
	}

	const req = https.request(options, (res) => {
		let responseData = ''

		res.on('data', (data) => {
			responseData += data
		})

		res.on('end', () => {
			/* Parse the response as XML. */
			const parser = new XMLParser({ignoreAttributes: false, attributeNamespacePrefix: '@_'})
			const doc = parser.parse(responseData)

			/* Extract the METAR string from the metar/@text attribute. */
			const raw = doc.metar['@_text']

			/* Split the METAR string into the individual pieces. */
			const parts = raw.split(' ')

			/* Create the parsed METAR data object. */
			metar = parseMetar(raw)
		})
	})

	req.write(`action=getMetar&icao=${config.metar.icao}`)
	req.end()
}

/* Fetch weather data at start and periodically. */
fetchMetar()
setInterval(fetchMetar, config.metar.update)

/* Message sent when no METAR data is available yet. */
const noMetarMessage = 'UNABLE, WEATHER INFORMATION IS NOT AVAILABLE AT THIS TIME'

/* Create the printed version of a METAR temperature value. */
function formatMetarTemp(temp) {
	let text = ''
	if (temp < 0) {
		text += 'MINUS '
	}
	text += Math.abs(temp)
	return text
}

/* Create the MQTT client and connect to the Corrade MQTT server. */
const mqttClient = mqtt.connect(config.corrade.mqtt)

/* Send a message on a specified channel. */
function say(channel, message) {
	const payload = {
		'command': 'tell',
		'group': config.corrade.group,
		'password': config.corrade.password,
		'entity': 'local',
		'type': 'Normal',
		'channel': channel,
		'message': message
	}

	const data = config.corrade.language === 'JSON' ? JSON.stringify(payload) : qs.stringify(payload)
	
	mqttClient.publish(`${config.corrade.group}/${config.corrade.password}/ownersay`, data)
}

/* Handle reconnects. */
mqttClient.on('reconnect', () => {
	logger.info('Reconnecting to Corrade MQTT server...')
})

/* Subscribe to the ownersay notification when connection is established successfully. */
mqttClient.on('connect', () => {
	mqttClient.subscribe(`${config.corrade.group}/${config.corrade.password}/ownersay`, (error) => {
		if (error) {
			logger.info(`Error subscribing to Corrade MQTT ownersay messages: ${error}`)
			return
		}

		logger.info('Subscribed to Corrade MQTT ownersay messages')

		/* Set GridTalkie handle. */
		say(11, `sethandle ${config.atc.handle}`)
	})
})

/* Log a message if the connection closes. */
mqttClient.on('close', () => {
	logger.error('Disconnected from Corrade MQTT server...')
})

/* Log a message if there is any error with the MQTT connection. */
mqttClient.on('error', (error) => {
	logger.error(`Error found while connecting to Corrade MQTT server: ${error}`)
})

/* Get a description of the wind from the current METAR. */
function windDescription() {
	if (metar.wind.speed < 1) {
		return 'CALM'
	}

	return `${metar.wind.heading} AT ${metar.wind.speed} KNOTS`
}

/* Format a standard ATC response to the specified callsign. */
function standardResponse(callsign, message) {
	return `${callsign}, ${config.atc.handle}, ${message}`
}

/* Create a response to ATC messages that fit certain patterns. */
function respondToATCMessage(channel, handle, message) {
	let result

	/* Flight plan */
	if (result = execPattern(flightPlanPattern, message)) {
		return standardResponse(result.groups.callsign, 'FLIGHT PLAN APPROVED. Squawk ${assignedSquawk}')
	}

	/* Radio check */
	if (result = execPattern(radioCheckPattern, message)) {
		return standardResponse(result.groups.callsign, 'CLEAR RADIO SIGNAL RECEIVED 5 BY 5.')
	}

	/* Wind check */
	if (result = execPattern(windCheckPattern, message)) {
		if (metar) {
			return standardResponse(result.groups.callsign, `WIND ${windDescription()}.`)
		} else {
			return standardResponse(result.groups.callsign, noMetarMessage)
		}
	}

	/* Weather */
	if (result = execPattern(weatherCheckPattern, message)) {
		if (metar) {
			let weather = `WIND ${windDescription()}. `

			weather += `VISIBILITY ${metar.visibility} MILES. `

			switch (metar.precipitation) {
				case '-RA':
					weather += 'LIGHT RAIN. '
					break
				case 'RA':
					weather += 'MODERATE RAIN. '
					break
				case '+RA':
					weather += 'HEAVY RAIN. '
					break
				case '-SN':
					weather += 'LIGHT SNOW. '
					break
				case 'SN':
					weather += 'MODERATE SNOW. '
					break
				case '+SN':
					weather += 'HEAVY SNOW. '
					break
			}

			weather += 'CLOUDS '
			switch (metar.clouds.type) {
				case 'CLR':
					weather += 'CLEAR'
					break
				case 'FEW':
					weather += 'FEW'
					break
				case 'SCT':
					weather += 'SCATTERED'
					break
				case 'BKN':
					weather += 'BROKEN'
					break
				case 'OVC':
					weather += 'OVERCAST'
					break
			}
			weather += ` AT ${metar.clouds.ceiling} FEET. `

			weather += `TEMPERATURE ${formatMetarTemp(metar.temperature)}. `
			weather += `DEWPOINT ${formatMetarTemp(metar.dewpoint)}. `
			weather += `ALTIMETER ${metar.altimeter}.`

			return standardResponse(result.groups.callsign, `LATEST WEATHER INFORMATION: ${weather}`)
		} else {
			return standardResponse(result.groups.callsign, noMetarMessage)
		}
	}

	/* Altimeter */
	if (result = execPattern(altimeterPattern, message)) {
		if (metar) {
			return standardResponse(result.groups.callsign, `ALTIMETER ${metar.altimeter}.`)
		} else {
			return standardResponse(result.groups.callsign, noMetarMessage)
		}
	}

	/* Visibility */
	if (result = execPattern(visibilityPattern, message)) {
		if (metar) {
			return standardResponse(result.groups.callsign, `VISIBILITY ${metar.visibility} MILES.`)
		} else {
			return standardResponse(result.groups.callsign, noMetarMessage)
		}
	}

	/* Temperature */
	if (result = execPattern(temperatureDewpointPattern, message)) {
		if (metar) {
			return standardResponse(result.groups.callsign, `TEMPERATURE ${formatMetarTemp(metar.temperature)}. DEWPOINT ${formatMetarTemp(metar.dewpoint)}.`)
		} else {
			return standardResponse(result.groups.callsign, noMetarMessage)
		}
	}

	/* Start */
	if (result = execPattern(startPattern, message)) {
		return standardResponse(result.groups.callsign, 'START APPROVED. CONTACT TOWER FOR DEPARTURE.')
	}

	/* Push back */
	if (result = execPattern(pushbackPattern, message)) {
		return standardResponse(result.groups.callsign, 'PUSH BACK APPROVED. REPORT BACK FOR TAXI CLEARANCE.')
	}

	/* Taxi to runway */
	if (result = execPattern(taxiRunwayPattern, message)) {
		return standardResponse(result.groups.callsign, `TAXI APPROVED. HOLD SHORT RUNWAY ${result.groups.runway}. CONTACT TOWER FOR DEPARTURE.`)
	}

	/* Taxi */
	if (result = execPattern(taxiPattern, message)) {
		return standardResponse(result.groups.callsign, 'TAXI APPROVED. HOLD SHORT DEPARTURE RUNWAY. CONTACT TOWER FOR DEPARTURE.')
	}

	/* Takeoff (helipad) */
	if (result = execPattern(takeOffHelipadPattern, message)) {
		return standardResponse(result.groups.callsign, `CLEARED FOR TAKE OFF FROM HELIPAD ${result.groups.helipad}. ${config.atc.departureInfoHelipad}`)
	}

	/* Takeoff (runway) */
	if (result = execPattern(takeOffRunwayPattern, message)) {
		return standardResponse(result.groups.callsign, `CLEARED FOR TAKE OFF RUNWAY ${result.groups.runway}. ${config.atc.departureInfoRunway}`)
	}

	/* Takeoff */
	if (result = execPattern(takeOffPattern, message)) {
		return standardResponse(result.groups.callsign, `CLEARED FOR TAKE OFF. ${config.atc.departureInfo}`)
	}

	/* Landing (helipad) */
	if (result = execPattern(landingHelipadPattern, message)) {
		return standardResponse(result.groups.callsign, `LANDING APPROVED ON HELIPAD ${result.groups.helipad}. ${config.atc.landingInfoHelipad}`)
	}

	/* Landing (runway) */
	if (result = execPattern(landingRunwayPattern, message)) {
		return standardResponse(result.groups.callsign, `LANDING APPROVED RUNWAY ${result.groups.runway}. ${config.atc.landingInfoRunway}`)
	}

	/* Landing */
	if (result = execPattern(landingPattern, message)) {
		return standardResponse(result.groups.callsign, `LANDING APPROVED. ${config.atc.landingInfo}`)
	}

	/* Approach */
	if (result = execPattern(approachPattern, message)) {
		return standardResponse(result.groups.callsign, `CONTINUE APPROACH. ${config.atc.approachInfo}`)
	}

	/* Other messages with a valid callsign */
	if (result = execPattern(otherCallsignPattern, message)) {
		return standardResponse(result.groups.callsign, 'SAY AGAIN?')
	}

	/* Other messages with no callsign */
	if (result = execPattern(otherPattern, message)) {
		return `AIRCRAFT CALLING ${config.atc.handle}, SAY AGAIN WITH CALLSIGN.`
	}

	/* Request Flight Following */
	if (result = execPattern(squawkRequestPattern, message)) {
    const assignedSquawk = generateConfiguredSquawk();
    return standardResponse(result.groups.callsign, `SQUAWK ${assignedSquawk} AND IDENT.`);
	}

	/* Ignore messages that match no pattern */
	return null
}

/* Handle MQTT messages from Corrade. */
mqttClient.on('message', (topic, message) => {
	/* Parse the JSON received from Corrade. */
	let mqttMessage = config.corrade.language === 'JSON' ? JSON.parse(message) : qs.parse(message)

	/* Ignore anything besides the ownersay notification. */
	if (mqttMessage.type !== 'ownersay') {
		return
	}

	/* Log the message. */
	logger.info(mqttMessage.message)

	/* Check if the message matches the GridTalkie pattern. */
	const result = execPattern(gtMessagePattern, mqttMessage.message)

	/* Ignore non-GridTalkie messages. */
	if (result === null) {
		return
	}

	/* Extract the GridTalkie channel, handle and message from the ownersay message. */
	const gtChannel = result.groups.channel
	const gtHandle = result.groups.handle
	const gtMessage = result.groups.message

	/* Log the incoming message in the transcript. */
	transcript.info(`{#${gtChannel}} ${gtHandle}: ${gtMessage}`)

	/* Ignore messages on GridTalkie channels we don't care about. */
	if (config.gridtalkie.channels[gtChannel] === undefined) {
		return
	}

	/* Create a response by matching the message to standard ATC patterns. */
	let response = respondToATCMessage(gtChannel, gtHandle, gtMessage)

	/* If a response was created, send it via GridTalkie on the appropriate channel. */
	if (response) {
		/* Get the SL text chat channel from the config mapping. */
		const channel = config.gridtalkie.channels[gtChannel]

		/* If no channel mapping is defined in the config, abort. */
		if (channel === undefined) {
			return
		}

		/* Send the response over GridTalkie. */
		say(channel, response)

		/* Log the response in the transcript. */
		transcript.info(`{#${gtChannel}} ${config.atc.handle}: ${response}`)
	}
})
