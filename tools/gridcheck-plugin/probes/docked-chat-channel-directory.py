from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient.xmppchatchannels import XmppChatChannels


def observe():
    window = XmppChatChannels.GetIfOpen()
    opened = window is None
    if opened:
        window = XmppChatChannels.Open()
    try:
        chat = GetChatService()
        rooms = chat.GetChannels()
        window.SetChannels(rooms)
        hits = chat.GetChannelByDisplayName('English Help')
        misses = chat.GetChannelByDisplayName('Codex directory missing fixture 13525')
        return dict(station=session.stationid, count=len(rooms), sample=rooms[:5], hits=hits, misses=misses,
                    labels=[GetByLabel(label) for label in ('UI/Neocom/ChatChannelsBtn', 'UI/Chat/ChannelName',
                            'UI/Chat/ChannelWindow/Name', 'UI/Chat/ChannelWindow/Members',
                            'UI/Chat/ChannelWindow/PlayerChannels', 'UI/Chat/ChannelWindow/MyChannels')])
    finally:
        if opened:
            window.Close()


result = observe()
