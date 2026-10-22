# PAD Voting

An interactive simulator for **Probabilistic Approval with Deference (PAD)** voting.

Set the options on the ballot, fill in ballots and how many voters cast each one, then randomly draw them from the box one at a time and watch each option's chance of winning update after every draw.

Live: https://yoav6.github.io/PAD-Voting/

Plain HTML, CSS and JavaScript, with no build step. Win probabilities are computed exactly over every possible draw order where feasible, and estimated by simulation otherwise.
