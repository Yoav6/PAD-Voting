###### Process
When a ballot is drawn:
1. Original votes (OVs)  
    Give +1 OV to every option the ballot approved (MP or not). 
    (This is pure approval and is used only to determine the current leader.)
2. Determine current leader (M)  
    M = the option with the most OVs so far. If there's a tie M is null.
3. Effective votes (EVs) — at most one per option, and the ballot as a whole contributes a limited number of EVs:
    - For every option the ballot approved without MP: give that option +1 EV.
    - If the ballot approved at least one option with MP and there's a current leader (no tie): give the current leader (M) +1 EV (only once, even if several options were marked MP).
        - If the leader (M) is itself one of the non-MP options the ballot already supported, it does not receive a second EV from the MP rule (still at most +1 total to any single option from this ballot).
    - If there's a tie (no leader) then MP marks are ignored and EVs and every option voted for gets an EV.
4. Stop condition  
    As soon as any option reaches 2 EVs, it wins.

###### Example 

Ballot:
- A: yes (no MP)
- B: yes (MP)
- C: yes (MP)
- D: no

On drawing it when D is already the current leader:
- OVs: A+1, B+1, C+1
- EVs:
    - A receives +1 EV (non-MP).
    - D receives +1 EV (because there was at least one MP).
    - B and C receive no EV (their support was delegated).