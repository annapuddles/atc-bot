# ATC bot for Corrade/GridTalkie

A Node.js program that connects to a Corrade MQTT server and responds to ATC messages received over specified channels on GridTalkie.

# Setup

The avatar being used for the bot must own one of the GridTalkie radios available here: https://marketplace.secondlife.com/stores/15411

Add the radio attachment and configure it as follows:

- Set the tuners and text chat channels as desired.

  Example:
  ```
  TUNER A /11 | CH: #12270-Gridwide ATC
  TUNER B /12 | CH: #11920-BLAKE
  ```

- Under Options, ensure SpkrOwner is enabled (received messages are sent as ownersay messages)

In [config.yml](config.yml), set `gridtalkie.channels` to match the tuner settings.

Example:
```yaml
gridtalkie:
    channels:
        12270-Gridwide ATC: 11
        11920-BLAKE: 12
```

Configure other options as desired, such as the handle the bot will use and the prefix it will respond to.

Run [main.js](main.js) to start the bridge.

# Messages

The general format for requests is as follows:

```
<airport callsign>, <your callsign>, <request>
```

You must include the commas between each part.

| Request | Pilot request example | Bot response example |
|---------|-----------------------|----------------------|
| Radio check | "SLYN tower, N12345, radio check." | "N12345, SLYN TOWER, CLEAR RADIO SIGNAL RECEIVED 5 BY 5." |
| Wind check | "SLYN tower, N12345, wind check." | "N12345, SLYN TOWER, WIND 330 AT 5 KNOTS." |
| Weather check | "SLYN tower, N12345, weather check." | "N12345, SLYN TOWER, LATEST WEATHER INFORMATION: WIND 330 AT 5 KNOTS. VISIBILITY 10 MILES. CLOUDS FEW AT 9000 FEET. TEMPERATURE 19. DEWPOINT 0. ALTIMETER 30.02." |
| Submitting a flight plan | "SLYN tower, N12345, flight plan SLYN > SLWS." | "N12345, SLYN TOWER, FLIGHT PLAN APPROVED." |
| Aircraft start-up | "SLYN tower, N12345, requesting start." | "N12345, SLYN TOWER, START APPROVED. CONTACT TOWER FOR DEPARTURE." |
| Take off | "SLYN  tower, N12345, requesting clearance for takeoff." | "N12345, SLYN TOWER, CLEARED FOR TAKE OFF." |
| Landing | "SLYN tower, N12345, requesting clearance to land." | "N12345, SLYN TOWER, LANDING APPROVED." |
| Landing on helipad | "SLYN tower, N12345, requesting clearance to land on helipad H1." | "N12345, SLYN TOWER, LANDING APPROVED ON HELIPAD H1." |
