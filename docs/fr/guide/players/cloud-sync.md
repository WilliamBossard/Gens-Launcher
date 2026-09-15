# Synchronisation Cloud Horizon (Guide Joueur)

<div style="display: flex; gap: 8px; margin: 1rem 0; flex-wrap: wrap;">
  <img src="https://img.shields.io/badge/Technologie-Delta%20Sync-blue.svg" alt="Delta Sync" />
  <img src="https://img.shields.io/badge/Fournisseurs-Google%20Drive%20%7C%20Dropbox%20%7C%20OneDrive-green.svg" alt="Fournisseurs" />
  <img src="https://img.shields.io/badge/Chiffrement-AES--256--GCM-red.svg" alt="Chiffrement" />
</div>

La technologie **Horizon Cloud Sync** est l'une des innovations majeures de Gens Launcher. Elle vous permet de synchroniser automatiquement vos instances Minecraft (mondes en solo, réglages de touches, inventaires, packs et mods) entre plusieurs ordinateurs en utilisant votre propre stockage cloud personnel.

---

## Comment fonctionne la Synchronisation Cloud ?

Contrairement aux solutions classiques qui renvoient l'intégralité d'un dossier de 500 Mo à chaque partie, Gens-Horizon utilise la synchronisation différentielle (**Delta Sync**) :
- Seuls les fichiers modifiés depuis votre dernière session sont analysés.
- Les données inchangées ne sont jamais retransférées.
- Une session de jeu ne consomme que quelques mégaoctets de bande passante et prend quelques secondes à être synchronisée.

---

## Connecter un Fournisseur Cloud

1. Rendez-vous dans les **Paramètres** de Gens Launcher -> onglet **Horizon Cloud**.
2. Choisissez votre fournisseur de stockage :
   - **Google Drive**
   - **Dropbox**
   - **Microsoft OneDrive**
3. Cliquez sur **Se connecter**. Une page d'autorisation officielle sécurisée s'ouvre dans votre navigateur web.
4. Accordez l'accès à l'application. Gens-Horizon chiffre les jetons d'accès sur votre disque avec une clé unique liée au matériel de votre machine (**PBKDF2** 600 000 itérations + **AES-256-GCM**).
5. Une fois connecté, votre quota restant s'affiche en temps réel dans l'interface.

---

## Activer la Synchronisation sur une Instance

1. Faites un clic droit sur l'instance de votre choix -> **Paramètres**.
2. Cochez l'option **Activer la Synchronisation Cloud Horizon**.
3. Deux modes sont disponibles :
   - **Mode Intelligent (Recommandé) :** Gens Launcher vérifie la présence d'une sauvegarde cloud plus récente avant de lancer le jeu, et envoie automatiquement vos modifications à la fermeture du jeu.
   - **Mode Manuel :** Vous déclenchez l'envoi ou la récupération quand vous le souhaitez à l'aide des boutons *Envoyer au Cloud* et *Restaurer depuis le Cloud*.

---

## Historique des Versions et Restauration (Rollback)

Si votre monde est corrompu ou si un mod endommage votre sauvegarde :
1. Allez dans l'onglet **Cloud** de l'instance.
2. Consultez l'historique chronologique de vos sessions de jeu.
3. Cliquez sur **Restaurer à ce point** pour rétablir exactement l'état de vos fichiers à la date sélectionnée.

---

## Sécurité et Confidentialité des Données

- **Votre stockage personnel :** Vos sauvegardes sont stockées exclusivement sur votre propre compte cloud (Google, Dropbox, Microsoft). Aucun serveur tiers ne conserve vos fichiers.
- **Protection par Verrouillage Atomique :** Si vous laissez votre jeu allumé sur un premier PC, un fichier de verrouillage (`horizon.lock`) empêche tout conflit d'écriture ou écrasement accidentel depuis un second ordinateur.
