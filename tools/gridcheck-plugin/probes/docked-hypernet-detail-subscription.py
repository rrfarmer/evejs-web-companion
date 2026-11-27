from raffles.client.raffle import Raffle

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(offer.raffle_id), lambda row: None)
initial = raffle.is_subscribed
try:
    raffle.subscribe()
    subscribed = raffle.is_subscribed
    raffle.subscribe()
    repeated = raffle.is_subscribed
finally:
    raffle.unsubscribe()
closed = raffle.is_subscribed
raffle.is_finished = True
raffle.subscribe()
result = dict(station=session.stationid, id=raffle.raffle_id, initial=initial,
              subscribed=subscribed, repeated=repeated, closed=closed, finished=raffle.is_subscribed)
