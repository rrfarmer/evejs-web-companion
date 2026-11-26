from localization import GetByLabel
from projectdiscovery.client.projects.covid.ui import rewards
from projectdiscovery.common.projects.covid.tiers import TIERS

def type_for(tier, gender):
    return tier['types'][0] if len(tier['types']) == 1 else tier['types'][gender]

result = {
    'station': session.stationid,
    'gender': session.genderID,
    'tiers': [[tier['level'], type_for(tier, session.genderID)] for tier in TIERS],
    'apparelVariants': [[tier['level'], list(tier['types'])] for tier in TIERS if len(tier['types']) > 1],
    'crateIDs': [rewards.LOOT_CRATE_TYPE_ID, rewards.SUPERIOR_LOOT_CRATE_TYPE_ID],
    'superiorRank': rewards.NEEDED_LEVEL_FOR_SUPERIOR_CRATES,
    'upcoming': GetByLabel(rewards.LABEL_PATH_UPCOMING_REWARDS),
    'redeem': GetByLabel(rewards.LABEL_PATH_REDEEM_ITEMS),
    'redeemLink': 'ShowRedeemUI' in rewards.REDEEM_WINDOW_URL
}
