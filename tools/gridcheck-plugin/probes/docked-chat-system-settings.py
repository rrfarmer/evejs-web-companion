import uthread2
from carbonui.util.bunch import Bunch
from carbon.common.script.sys import service
from eveservices.xmppchat import GetChatService
from xmppchatclient import xmppchannelfield
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg, GetFieldsFromConfig


def directory_actions(room):
    names = ('JoinChannel', 'LeaveChannel', 'Settings', 'ForgetChannel', 'DeleteChannel')
    field = Bunch(sr=Bunch(node=Bunch(channel=room)), OnClick=lambda: None)
    for name in names:
        field[name] = lambda: None
    return [next(name for name in names if field[name] is entry[1])
            for entry in xmppchannelfield.XmppChannelField.GetMenu.im_func(field) or []]


def observe():
    chat = GetChatService()
    can_grant = bool(session.role & service.ROLE_GML)
    rooms = sorted(row for row in chat.GetChannels() if len(row) > 2 and row[0].startswith('system_'))
    room = next(row[0] for row in rooms if row[1] == 'English Help')
    was_joined = chat.IsJoined(room)
    window = None
    try:
        if not was_joined:
            chat.JoinChannel(room, suppressMessage=True)
            for _ in range(40):
                if chat.IsJoined(room):
                    break
                uthread2.sleep(0.25)
        if not chat.IsJoined(room):
            raise RuntimeError('Could not join the native English Help room')
        actions = directory_actions(room)
        before = dict(owner=chat.IsOwnerOfChannel(room), operator=chat.IsOperatorOfChannel(room),
                      form=bool(GetFieldsFromConfig(chat.GetChannelConfig(room))))
        if 'Settings' in actions:
            # On an isolated reference fixture, the native GM window can promote the observer.
            window = ChannelSettingsDlg.Open(channel=room, windowID='ChannelSettingsDlg_%s' % room)
        return dict(station=session.stationid, room=room, systemRooms=len(rooms),
                    gml=can_grant, administrator=bool(session.role & service.ROLE_CHTADMINISTRATOR),
                    actions=actions, before=before, after=dict(owner=chat.IsOwnerOfChannel(room),
                    operator=chat.IsOperatorOfChannel(room)), settings=dict(name=window.channelName.GetValue(),
                    operatorOnly=window.operatorOnly, access=window.accessTypeCombo.GetValue()
                    if not window.operatorOnly else None, motd=window.motd.GetValue()) if window else None)
    finally:
        if window and not window.destroyed:
            window.Close()
        if not was_joined:
            chat.LeaveChannel(room)


result = observe()
