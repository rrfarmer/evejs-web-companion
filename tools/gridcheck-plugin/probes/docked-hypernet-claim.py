from raffles.client.localization import Text
from raffles.client.raffle import Raffle
from raffles.client.raffle_service import RaffleService
from raffles.common.const import RaffleStatus
from raffles.common.errors import RafflesError

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(offer.raffle_id), lambda row: None)
class WinningTicket(object):
    owner_id = session.charid
class Proxy(object):
    def __init__(self):
        self.awarded = []
    def AwardItem(self, id):
        self.awarded.append(id)
class Recorder(object):
    proxy = Proxy()

raffle.update_winning_ticket(WinningTicket())
claimable = raffle.is_unclaimed
record = Recorder()
RaffleService.claim_reward.im_func(record, raffle)
after = int(raffle.raffle_status)
repeatRefused = False
try:
    RaffleService.claim_reward.im_func(record, raffle)
except RafflesError:
    repeatRefused = True
result = dict(station=session.stationid, id=raffle.raffle_id, claimable=bool(claimable), status=after,
              stillClaimable=bool(raffle.is_unclaimed), writes=record.proxy.awarded,
              repeatRefused=repeatRefused, claimLabel=Text.claim_reward(),
              receipt=Text.reward_claimed(item_name=raffle.item_name))
