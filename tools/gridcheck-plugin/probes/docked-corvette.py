# Read the installed client's docked corvette button without changing ships.
# From EveOffline, use gridcheck client eval --json --file with this file.
from eve.client.script.ui.shared.dockedUI.lobbyWnd import LobbyWnd

lobby = LobbyWnd.GetIfOpen()
if not lobby:
    raise RuntimeError('Docked lobby is not open')

button = next(child for child in lobby.corvetteButtonParent.children
              if child.name == 'corvetteButton')
result = {
    'station': session.stationid,
    'structure': session.structureid,
    'label': button.default_label,
    'enabled': bool(button.controller.is_enabled),
    'aboard': bool(button.controller.is_aboard_corvette),
    'rect': list(button.GetAbsolute()),
}
