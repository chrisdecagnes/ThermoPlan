# ThermoPlan 2.12.1

Première version publique de ThermoPlan, réécriture pour le SDK 3 de [homey-heating](https://github.com/mskg/homey-heating) (Markus Kling, GPL-3.0), étendue à la climatisation et aux ventilateurs.

## Principales fonctions

- Programmes de **chauffage**, **climatisation** et **ventilation** en plages horaires, avec graphique de la semaine et boutons Tester.
- **Saisons** selon les dates ou selon la **température extérieure** (moyenne glissante, mi-saison).
- Climatiseurs aux noms de modes propres à la marque (ex. **Daikin**), ventilation de la clim par plage (Auto, Silence, 1…N).
- **Fenêtre ouverte** : arrêt du programme ou de la pièce après un délai.
- **Sonde de la pièce** : affichage ou régulation (y compris ventilation selon la température).
- **Personne à la maison** : pause de toutes les programmations.
- Thermostat virtuel par programme, 6 modes, cartes Flow, **widget de tableau de bord** avec graphique des dernières 24 heures.
- Langues : français, anglais, néerlandais, allemand.

## Nouveautés de la 2.12.1

- Widget : correction d'un widget pouvant rester vide sur certaines versions de Homey.
- Les initiales des jours des plages suivent la langue de Homey.

## Prérequis

Homey Pro (2023 ou plus récent), Homey 12.3.0 ou plus.

Historique complet : [CHANGELOG.md](../CHANGELOG.md).
