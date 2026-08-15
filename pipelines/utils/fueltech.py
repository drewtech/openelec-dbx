"""Fueltech -> group / renewable-flag mapping.

Hardcoded because this taxonomy only exists in OpenElectricity's docs
(docs.openelectricity.org.au/guides/fueltechs), never in an API response.
Fueltechs absent from FUELTECH_GROUPS get no group (null) rather than an
invented one: nuclear, imports, exports, interconnector, aggregator_vpp,
aggregator_dr.

Exposes Column-expression builders, not a UDF, so the mapping can be used
inline in Spark DataFrame code without UDF serialization overhead.
"""

from pyspark.sql import functions as F
from pyspark.sql.column import Column

FUELTECH_GROUPS: dict[str, str] = {
    "coal_black": "coal",
    "coal_brown": "coal",
    "gas_ccgt": "gas",
    "gas_ocgt": "gas",
    "gas_recip": "gas",
    "gas_steam": "gas",
    "gas_wcmg": "gas",
    "solar_rooftop": "solar",
    "solar_thermal": "solar",
    "solar_utility": "solar",
    "wind": "wind",
    "wind_offshore": "wind",
    "bioenergy_biogas": "bioenergy",
    "bioenergy_biomass": "bioenergy",
    "hydro": "hydro",
    "distillate": "distillate",
    "pumps": "pumps",
    "battery_charging": "battery_charging",
    "battery_discharging": "battery_discharging",
}

RENEWABLE_GROUPS = {"solar", "wind", "hydro", "bioenergy"}


def fueltech_group_expr(fueltech_col: Column) -> Column:
    """Map a fueltech_id column to its group. Unmapped techs -> null."""
    mapping = F.create_map([F.lit(x) for pair in FUELTECH_GROUPS.items() for x in pair])
    return mapping.getItem(fueltech_col)


def is_renewable_expr(fueltech_col: Column) -> Column:
    """True/False, or null when the fueltech has no group at all."""
    group = fueltech_group_expr(fueltech_col)
    return F.when(group.isNotNull(), group.isin(*RENEWABLE_GROUPS))
