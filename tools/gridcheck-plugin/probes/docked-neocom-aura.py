import blue
from auraguidance.client.ui.window import AuraGuidanceWindow
from neocom2.btnIDs import AURA_GUIDANCE_ID


def observe():
    neocom = sm.GetService('neocom')
    if AuraGuidanceWindow.GetIfOpen():
        return {'alreadyOpen': True}
    try:
        panel = neocom.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        entry = next((row for row in rows if row.btnData.id == AURA_GUIDANCE_ID), None)
        observation = {'station': session.stationid, 'available': entry is not None}
        if not entry:
            return observation
        observation.update({'index': rows.index(entry), 'label': entry.GetLabel(), 'command': entry.btnData.cmdName,
                            'icon': entry.btnData.iconPath})
        window = AuraGuidanceWindow.Open()
        observation.update({'windowID': window.default_windowID, 'size': [window.width, window.height],
                            'messages': [row.message_text for row in window._message_entries]})
        if getattr(window, '_input_field', None):
            window.send_message('How do I mine?')
            for _ in xrange(60):
                if not window._is_waiting_globally:
                    break
                blue.synchro.SleepWallclock(100)
            observation['reply'] = window._message_entries[-1].message_text
        return observation
    finally:
        neocom.CloseAllPanels()
        window = AuraGuidanceWindow.GetIfOpen()
        if window:
            window.Close()


result = observe()
