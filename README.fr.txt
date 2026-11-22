ThermoPlan programme votre chauffage, votre climatisation et vos ventilateurs depuis un seul endroit, au fil des saisons.

Un programme est une liste hebdomadaire de consignes appliquées à des zones et des appareils Homey :
- Les programmes de chauffage règlent la température de consigne de vos thermostats et têtes thermostatiques.
- Les programmes de climatisation allument vos climatiseurs en mode « froid » avec une consigne, ou les éteignent.
- Les programmes de ventilation allument ou éteignent vos ventilateurs et règlent leur vitesse.

Saisons : en hiver les programmes de chauffage s'exécutent, en été ceux de climatisation et de ventilation. La saison suit des dates configurables, ou la température extérieure moyenne mesurée par la sonde de votre choix (été au-dessus d'un seuil, hiver en dessous d'un autre, mi-saison entre les deux), ou se règle à la main ou par un Flow. Un programme peut aussi tourner toute l'année.

Modes avec exceptions par programme : Automatique, Journée à la maison, Journée d'absence, Nuit, Vacances, Hors saison. Les modes temporaires reviennent en Automatique à minuit.

Chaque programme de chauffage ou de climatisation peut être ajouté comme thermostat virtuel pour forcer sa température jusqu'à minuit ou en permanence.

Cartes Flow : appliquer les programmes, changer de mode ou de saison, activer ou désactiver un programme, conditions sur le mode, la saison et les programmes. Jetons : mode, saison, prochain changement, température extérieure moyenne.

Basé sur Homey Heating Scheduler de Markus Kling (GPL-3.0).
