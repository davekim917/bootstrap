{{ config(materialized='table', alias='--not-a-comment') }}
{# jinja comment
   over two lines #}
select '{# still a jinja comment #}' as a
{% if true %} -- sql comment after a block {% endif %}
from {{ ref('x') }}
