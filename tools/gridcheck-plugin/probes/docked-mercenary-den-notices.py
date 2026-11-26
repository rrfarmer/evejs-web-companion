from eveProto.generated.eve_public.sovereignty.mercenaryden.activity.api.notices_pb2 import AddedNotice, RemovedNotice
from sovereignty.mercenaryden.client.mocks.request_messenger_mock import MockMercenaryDenRequestMessenger
from sovereignty.mercenaryden.client.notice_listener import ExternalNoticeListener

class NoticeRegistry(object):
    def __init__(self):
        self.types = []
        self.callbacks = {}

    def subscribe_to_notice(self, message_type, callback):
        self.types.append(dict(type=message_type.DESCRIPTOR.full_name,
                               fields=[field.name for field in message_type.DESCRIPTOR.fields]))
        self.callbacks[message_type] = callback

    def receive(self, message):
        received = type(message)()
        received.ParseFromString(message.SerializeToString())
        self.callbacks[type(message)](received)

registry = NoticeRegistry()
listener = ExternalNoticeListener(registry)
callbacks = []

def on_added(system_id, activity):
    callbacks.append(dict(kind='added', id=str(activity.id), denID=activity.den_id,
                          systemID=system_id, activitySystemID=activity.solar_system_id,
                          started=activity.is_started, hasExpiry=bool(activity.expiry)))

def on_removed(den_id, activity_id):
    callbacks.append(dict(kind='removed', id=str(activity_id), denID=den_id))

listener.on_added_notice.connect(on_added)
listener.on_removed_notice.connect(on_removed)
activities, _ = MockMercenaryDenRequestMessenger().get_all_activities_for_den_request(990000013581)
sample = activities[0].get_for_merc_den_activity_response_proto()
registry.receive(AddedNotice(id=sample.id, activity=sample.attributes, solar_system=sample.attributes.solar_system))
registry.receive(RemovedNotice(id=sample.id, mercenary_den=sample.attributes.mercenary_den))
result = dict(station=session.stationid, notices=registry.types, callbacks=callbacks)
