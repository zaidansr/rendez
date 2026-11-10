# Rendez

Rendez is a **local, interactive desktop UI prototype** for coordinating people and AI agents. Its team, messages, tasks, activity, and file list are sample data stored in your browser's local storage. There is no account, backend, synchronization, live agent, or real multi-person collaboration. Sending a message adds it locally; any agent response is explicitly marked as a demo simulation.

## Run as a desktop app

With Node.js and npm installed:

```bash
npm install
npm start
```

Electron is the only install dependency. The interface itself loads no network assets or libraries.

## Preview in a browser

Open `index.html` directly. Browser storage is separate from Electron's storage, so your demo changes do not transfer between them.

## Try it

- Switch between Overview, Conversation, Tasks, and Files.
- Use **New task** to add a task, open a card, and change its status or review decision.
- Send a message in Conversation. Choose **Simulate agent reply** to add a clearly labeled sample response.
- Search tasks, conversations, and files with the top search field or `Ctrl/Cmd + K`.
- Change light and dark themes with the top right control. The choice persists locally.

Task changes, messages, and theme are saved in local storage. To reset the sample workspace, clear the site's local storage.

