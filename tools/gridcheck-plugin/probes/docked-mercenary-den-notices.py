from datetime import timedelta
from eveProto.generated.eve_public.sovereignty.mercenaryden.activity.api.notices_pb2 import AddedNotice, ExpiryChangedNotice, RemovedNotice
from eveProto.generated.eve_public.sovereignty.mercenaryden.api.notices_pb2 import EvolutionStateChangedNotice
from sovereignty.mercenaryden.client.activity_cache import ActivityCache
from sovereignty.mercenaryden.client.data.evolution_simulation import EvolutionSimulationInfo
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

cache = ActivityCache()
cache.add_activity(activities[0])
expiry_change = {}

def on_expiry_changed(previous_expiry, activity):
    cache.add_activity(activity)
    expiry_change.update(id=str(activity.id), denID=activity.den_id, started=activity.is_started,
                         previous=previous_expiry.isoformat(), current=activity.expiry.isoformat(),
                         cacheCount=len(cache.get_activities()))

listener.on_expiry_changed_notice.connect(on_expiry_changed)
expiry_notice = ExpiryChangedNotice(id=sample.id, activity=sample.attributes,
                                   previous_expiry=sample.attributes.expiry)
expiry_notice.activity.expiry.FromDatetime(activities[0].expiry + timedelta(minutes=15))
expiry_notice.activity.started = True
registry.receive(expiry_notice)
cached = cache.get_activity_by_id(activities[0].id)
expiry_change['cachedExpiry'] = cached.expiry.isoformat()
evolution_change = {}

def on_evolution_changed(den_id, state):
    evolution_change.update(denID=den_id, development=state.development_level, developmentStage=state.development_stage,
                            anarchy=state.anarchy_level, anarchyStage=state.anarchy_stage, paused=state.is_paused,
                            developmentSimulatedAt=bool(state.development_last_simulated_at),
                            anarchySimulatedAt=bool(state.anarchy_last_simulated_at))

listener.on_evolution_simulation_changed_notice.connect(on_evolution_changed)
state = EvolutionSimulationInfo(20, 2, 40, 3, False, development_last_simulated_at=sample.attributes.expiry,
                               anarchy_last_simulated_at=sample.attributes.expiry)
registry.receive(EvolutionStateChangedNotice(mercenary_den=sample.attributes.mercenary_den, state=state.get_proto()))
result = dict(station=session.stationid, notices=registry.types, callbacks=callbacks,
              expiryChange=expiry_change, evolutionChange=evolution_change)
