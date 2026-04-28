/* ATC bot bridge between Corrade and GridTalkie. */

const mqtt = require('mqtt')
const winston = require('winston')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { XMLParser } = require('fast-xml-parser')
const yaml = require('yamljs')

/* Read settings from config.yml */
const config = yaml.load('config.yml')

/* Pattern to identify the channel, handle and text of GridTalkie messages:
 *
 * {#<channel>} <handle>: <message>
 *
 */
const gtMessagePattern = /^{#([^}]+)} ([^:]+): (.*)$/g

/* Create a regex using a standard ATC message format:
 *
 * <ICAO>, <callsign>, <request>
 *
 * */
function basicATCPattern(keywords) {
	return new RegExp(`^${config.atc.prefix} ?.*, ?(.*),.*(?:\\b${keywords}\\b).*$`, 'gi')
}

/* ATC message patterns.
 *
 * Simple messages can use the basicATCPattern to match specific keywords in
 * the request.
 *
 * More complex messages will need to be done as a custom regex.
 */
const flightPlanPattern = basicATCPattern('flight ?plan')
const radioCheckPattern = basicATCPattern('radio ?(check|test)')
const windCheckPattern = basicATCPattern('wind ?check')
const startPattern = basicATCPattern('start ?(up)?')
const takeOffPattern = basicATCPattern('take ?off|depart(ure)?')
const landingPattern = basicATCPattern('land(ing)?')
const weatherCheckPattern = basicATCPattern('weather')
const landingHelipadPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(.*),.*\\bland(?:ing)?\\b.*\\bhelipad ([0-9a-z]+)\\b.*$`, 'gi')
const otherCallsignPattern = new RegExp(`^${config.atc.prefix} ?.*, ?(.*),.*$`, 'gi')
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
			filename: path.join(path.dirname(fs.realpathSync(__filename)), config.log)
		})
	]
})

/* The current weather information from Shergood, or null if no weather info
 * has been retrieved yet.
 */
let metar = null

/* Shergood METAR regex pattern */
const metarPattern = /^(?<icao>[A-Z0-9]+) (?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})Z AUTO (?<hdg>\d{3})(?<spd>\d{2})KT (?<vis>\d+)SM ?(?<precip>-RA|RA|\+RA|-SN|SN|\+SN)? (?<type>CLR|FEW|SCT|BRK|OVC)(?<ceil>\d{3}) (?<temp>M?\d{2})\/(?<dew>M?\d{2}) A(?<alt>\d{4}) RMK AO2$/i

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
	const result = metarPattern.exec(raw)

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
	
	mqttClient.publish(`${config.corrade.group}/${config.corrade.password}/ownersay`, JSON.stringify(payload))
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

/* Return array of all matches of a regex pattern on a string. */
function matchesPattern(str, pattern) {
	return [...str.matchAll(pattern)]
}

/* Get a description of the wind from the current METAR. */
function windDescription() {
	if (metar.wind.speed < 1) {
		return 'CALM';
	}

	return `${metar.wind.heading} AT ${metar.wind.speed} KNOTS`;
}

/* Create a response to ATC messages that fit certain patterns. */
function respondToATCMessage(message) {
	/* Flight plan */
	if ((matches = matchesPattern(message, flightPlanPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, FLIGHT PLAN APPROVED.`
	}

	/* Radio check */
	if ((matches = matchesPattern(message, radioCheckPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, CLEAR RADIO SIGNAL RECEIVED 5 BY 5.`
	}

	/* Wind check */
	if ((matches = matchesPattern(message, windCheckPattern)).length > 0) {
		const callsign = matches[0][1]

		if (metar) {
			return `${callsign}, ${config.atc.handle}, WIND ${windDescription()}.`
		} else {
			return `${callsign}, ${config.atc.handle}, UNABLE, WEATHER INFORMATION NOT AVAILABLE AT THIS TIME.`
		}
	}

	/* Weather */
	if ((matches = matchesPattern(message, weatherCheckPattern)).length > 0) {
		const callsign = matches[0][1]

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

			weather += 'TEMPERATURE '
			if (metar.temperature < 0) {
				weather += 'MINUS '
			}
			weather += `${Math.abs(metar.temperature)}. `

			weather += 'DEWPOINT '
			if (metar.dewpoint < 0) {
				weather += 'MINUS '
			}
			weather += `${Math.abs(metar.dewpoint)}. `

			weather += `ALTIMETER ${metar.altimeter}.`

			return `${callsign}, ${config.atc.handle}, LATEST WEATHER INFORMATION: ${weather}`
		} else {
			return `${callsign}, ${config.atc.handle}, UNABLE. WEATHER INFORMATION NOT AVAILABLE AT THIS TIME.`
		}
	}

	/* Start */
	if ((matches = matchesPattern(message, startPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, START APPROVED. CONTACT TOWER FOR DEPARTURE.`
	}

	/* Takeoff */
	if ((matches = matchesPattern(message, takeOffPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, CLEARED FOR TAKE OFF. ${config.atc.departureInfo}`
	}

	/* Landing (helipad) */
	if ((matches = matchesPattern(message, landingHelipadPattern)).length > 0) {
		const callsign = matches[0][1]
		const helipad = matches[0][2]

		return `${callsign}, ${config.atc.handle}, LANDING APPROVED ON HELIPAD ${helipad}. ${config.atc.approachInfo}`
	}

	/* Landing */
	if ((matches = matchesPattern(message, landingPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, LANDING APPROVED. ${config.atc.approachInfo}`
	}

	/* Other messages with a valid callsign */
	if ((matches = matchesPattern(message, otherCallsignPattern)).length > 0) {
		const callsign = matches[0][1]

		return `${callsign}, ${config.atc.handle}, SAY AGAIN?`
	}

	/* Other messages with no callsign */
	if ((matches = matchesPattern(message, otherPattern)).length > 0) {
		return `AIRCRAFT CALLING ${config.atc.handle}, SAY AGAIN WITH CALLSIGN.`
	}

	/* Ignore messages that match no pattern */
	return null
}

/* Handle MQTT messages from Corrade. */
mqttClient.on('message', (topic, message) => {
	/* Parse the JSON received from Corrade. */
	let mqttMessage = JSON.parse(message)

	/* Ignore anything besides the ownersay notification. */
	if (mqttMessage.type !== 'ownersay') {
		return
	}

	/* Log the message. */
	logger.info(mqttMessage.message)

	/* Check if the message matches the GridTalkie pattern. */
	const matches = [...mqttMessage.message.matchAll(gtMessagePattern)]

	/* Ignore non-GridTalkie messages. */
	if (matches.length === 0) {
		return
	}

	/* Extract the GridTalkie channel, handle and message from the ownersay message. */
	const gtChannel = matches[0][1]
	const gtHandle = matches[0][2]
	const gtMessage = matches[0][3]

	/* Ignore messages on GridTalkie channels we don't care about. */
	if (config.gridtalkie.channels[gtChannel] === undefined) {
		return
	}

	/* Create a response by matching the message to standard ATC patterns. */
	const response = respondToATCMessage(gtMessage)

	/* If a response was created, send it via GridTalkie on the appropriate channel. */
	if (response) {
		const channel = config.gridtalkie.channels[gtChannel]

		if (channel === undefined) {
			return
		}

		say(channel, response.toUpperCase())
	}
})
