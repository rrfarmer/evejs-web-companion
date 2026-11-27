# Read labels from the native Guests row menu without invoking any actions.
import blue
from eve.client.script.ui.shared.dockedUI.lobbyWnd import GUESTSPANEL, LobbyWnd

social_actions = {
    'trade': 'UI/Market/TradeWithCharacter',
    'conversation': 'UI/Chat/StartConversation',
    'formFleet': 'UI/Fleet/FormFleetWith',
    'inviteFleet': 'UI/Fleet/InvitePilotToFleet',
}

lobby = LobbyWnd.GetIfOpen()
if not lobby:
    raise RuntimeError('Docked lobby is not open')

tabs = lobby._tabs
previous_tab = tabs.GetSelectedID()
tabs.SelectByID(GUESTSPANEL)
panel = lobby._guests_panel
try:
    for attempt in range(40):
        rows = [node for node in panel._scroll.GetNodes() if node.panel is not None]
        if rows:
            break
        blue.synchro.SleepWallclock(100)
    else:
        raise RuntimeError('No visible Guests rows')
    samples = []
    for node in rows:
        menu = node.panel.GetMenu()
        labels = []
        for entry in menu:
            if entry is None:
                continue
            if isinstance(entry, (tuple, list)):
                label = entry[0]
                if isinstance(label, tuple):
                    label = label[0]
            else:
                label = entry.GetTextDescriptive()
            labels.append(unicode(label))
        samples.append({'pilot': node.charID, 'name': node.label, 'self': node.charID == session.charid,
                        'menu': labels, 'socialActions': [key for key in sorted(social_actions) if social_actions[key] in labels]})
    result = {'station': session.stationid, 'structure': session.structureid, 'rows': samples}
finally:
    if previous_tab and previous_tab != GUESTSPANEL:
        tabs.SelectByID(previous_tab)
