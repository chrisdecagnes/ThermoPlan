ThermoPlan schedules your heating, air conditioning and fans from one place, season by season.

A schedule is a weekly list of set points applied to Homey zones and devices:
- Heating schedules set the target temperature of your thermostats and radiator valves.
- Cooling schedules switch your air conditioners on in "cool" mode with a target temperature, or turn them off.
- Fan schedules switch your fans on or off and set their speed.

Seasons: in winter the heating schedules run, in summer the cooling and fan schedules run. The season follows configurable dates, or the average outdoor temperature measured by the sensor of your choice (summer above one threshold, winter below another, mid-season in between), or can be set by hand or from a Flow. A schedule can also run all year.

Modes with per-schedule exceptions: Automatic, One day at home, One day away, Sleeping, Holiday, Out of season. Temporary modes switch back to Automatic at midnight.

Every heating or cooling schedule can be added as a virtual thermostat to override its temperature by hand until midnight, or permanently.

Flow cards: apply schedules, change mode or season, enable or disable a schedule, conditions on mode, season and schedule. Tokens: mode, season, next change, average outdoor temperature.

Based on Homey Heating Scheduler by Markus Kling (GPL-3.0).
