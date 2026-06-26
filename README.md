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
| Weather report | "SLYN tower, N12345, say weather report." | "N12345, SLYN TOWER, LATEST WEATHER INFORMATION: WIND 330 AT 5 KNOTS. VISIBILITY 10 MILES. CLOUDS FEW AT 9000 FEET. TEMPERATURE 19. DEWPOINT 0. ALTIMETER 30.02." |
| Wind check | "SLYN tower, N12345, wind check." | "N12345, SLYN TOWER, WIND 330 AT 5 KNOTS." |
| Visibility | "SLYN tower, N12345, say visibility." | "N12345, SLYN TOWER, VISIBILITY 10 MILES." |
| Temperature | "SLYN tower, N12345, say temperature." | "N12345, SLYN TOWER, TEMPERATURE 19. DEWPOINT 0." |
| Altimeter | "SLYN tower, N12345, say altimeter." | "N12345, SLYN TOWER, ALTIMETER 30.02." |
| Submitting a flight plan | "SLYN tower, N12345, flight plan SLYN > SLWS." | "N12345, SLYN TOWER, FLIGHT PLAN APPROVED. SQUAWK 1824." |
| Aircraft start-up | "SLYN tower, N12345, request start." | "N12345, SLYN TOWER, START APPROVED. CONTACT TOWER FOR DEPARTURE." |
| Push back | "SLYN tower, N12345, request push back." | "N12345, SLYN TOWER, PUSH BACK APPROVED. REPORT BACK FOR TAXI CLEARANCE." |
| Taxi | "SLYN tower, N12345, request clearance for taxi to runway 9." | "N12345, SLYN TOWER, TAXI APPROVED. HOLD SHORT RUNWAY 9. CONTACT TOWER FOR DEPARTURE." |
| Take off | "SLYN  tower, N12345, request clearance for takeoff." | "N12345, SLYN TOWER, CLEARED FOR TAKE OFF." |
| Take off from helipad | "SLYN tower, N12345, request clearance for take off from helipad H1." | "N12345, SLYN TOWER, CLEARED FOR TAKE OFF FROM HELIPAD H1." |
| Take off from runway | "SLYN tower, N12345, request clearance for take off from runway 9." | "N12345, SLYN TOWER, CLEARED FOR TAKE OFF RUNWAY 9." |
| Flight following | "SLYN tower, N12345, request flight following." | "N12345, SLYN TOWER, SQUAWK 1824 AND IDENT." |
| Approach | "SLYN tower, N12345, eta 5 mins." | "N12345, SLYN TOWER, CONTINUE APPROACH." |
| Landing | "SLYN tower, N12345, request clearance to land." | "N12345, SLYN TOWER, LANDING APPROVED." |
| Landing on helipad | "SLYN tower, N12345, request clearance to land on helipad H1." | "N12345, SLYN TOWER, LANDING APPROVED ON HELIPAD H1." |
| Landing via runway | "SLYN tower, N12345, request clearance to land via runway 27." | "N12345, SLYN TOWER, LANDING APPROVED RUNWAY 27." |

# Example

A working example of this bot is running at Hyena Heliport (SLYN), and can be interacted with using the prefix `SLYN` on the following GridTalkie channels:

| Channel | Description                 |
|---------|-----------------------------|
| #12755  | Hyena Heliport (SLYN) tower |
| #12270  | Gridwide ATC                |
| #11920  | Blake Sea ATC               |
