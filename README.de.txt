ThermoPlan steuert Heizung, Klimaanlage und Ventilatoren an einem Ort, Jahreszeit für Jahreszeit.

Ein Zeitplan ist eine wöchentliche Liste von Solltemperaturen für Homey-Zonen und -Geräte:
- Heizzeitpläne setzen die Solltemperatur deiner Thermostate und Heizkörperventile.
- Kühlzeitpläne schalten deine Klimaanlagen im Modus „Kühlen“ mit einer Solltemperatur ein oder schalten sie aus.
- Lüftungszeitpläne schalten deine Ventilatoren ein oder aus und setzen ihre Geschwindigkeit.

Jahreszeiten: Im Winter laufen die Heizzeitpläne, im Sommer die Kühl- und Lüftungszeitpläne. Die Jahreszeit folgt einstellbaren Daten oder der durchschnittlichen Außentemperatur eines Sensors deiner Wahl (Sommer über einer Schwelle, Winter unter einer anderen, Übergangszeit dazwischen) oder wird von Hand bzw. per Flow gesetzt. Ein Zeitplan kann auch ganzjährig laufen.

Modi mit Ausnahmen pro Zeitplan: Automatisch, Ein Tag zu Hause, Ein Tag außer Haus, Nacht, Urlaub, Außerhalb der Saison. Vorübergehende Modi kehren um Mitternacht zu Automatisch zurück.

Außerdem: Stopp bei offenem Fenster, Raumsensor mit Regelung, Pause wenn niemand zu Hause ist, Diagramm der letzten 24 Stunden und ein Widget für das Dashboard.

Jeder Heiz- oder Kühlzeitplan kann als virtueller Thermostat hinzugefügt werden, um die Temperatur bis Mitternacht oder dauerhaft von Hand zu überschreiben.

Flow-Karten: Zeitpläne anwenden, Modus oder Jahreszeit ändern, einen Zeitplan aktivieren oder deaktivieren, Bedingungen für Modus, Jahreszeit und Zeitplan. Tokens: Modus, Jahreszeit, nächste Änderung, durchschnittliche Außentemperatur.

Basiert auf Homey Heating Scheduler von Markus Kling (GPL-3.0).
