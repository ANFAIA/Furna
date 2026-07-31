Good. Here is the protocol, starting with the two things that can invalidate the whole experiment before you even run it.

## 1. The token budget is the real risk

1-bit QAT starting from FP pretrained weights does not recover on wikitext-2. That's ~2M tokens; the BitNet literature recovers with orders of magnitude more. If you run `train.py --dataset wikitext --epochs 3` you will get a bad perplexity and conclude the method does not work, when the only thing you will have measured is that you did not train enough.

Two honest ways out:

- **Rent a GPU.** An A100 for two or three days on Lambda or RunPod is 100-200 dollars and buys you between 500M and 1B tokens over FineWeb-Edu or a slice of C4. This is the option that produces a defensible absolute result.
- **Reframe it as a fixed budget.** "Under a 200M-token recovery budget, do attention residuals help?" That is a perfectly valid comparative question, it can be answered on your M4, and it does not require the absolute perplexity to be good. You just have to declare it starting from the title.

The second is the one I would pick for the first version. The first one, if the result turns out to be interesting.

## 2. Check α before anything else

Your gate is learnable with init=0. **Before the full grid, train a single arm and look at α per layer at the end.**

If α stays pinned at zero, the AR is doing nothing and you have a null result in two days instead of in three weeks. If it grows, look at which layers too — if it only wakes up in the deep ones, that is already half the story you are going to tell.

## 3. The minimum grid

Four cells, and the most important one is missing:

| Arm | Quantization | AR | What for |
|---|---|---|---|
| A | FP32 | no | reference ceiling |
| B | FP32 | yes | does the AR help on its own? |
| C | 1-bit QAT | **no** | **the real baseline** |
| D | 1-bit QAT | yes | the claim |

**C is the critical cell and it is the one you do not have.** Without it you cannot say anything at all: D compared only against A confounds the effect of quantization with that of the AR.

And B matters more than it looks, because it defines what your finding is. If the AR helps as much in FP32 as at 1 bit, your result is "attention residuals help" — true, small, and not your thesis. What is interesting is the **interaction**: that it helps *more* at 1 bit than in FP32. There you do have a mechanism to tell — extreme quantization destroys per-layer precision, and a direct path to previous attention outputs partly compensates for it.

Write that hypothesis down before running anything.

## 4. What makes the result credible

**Seeds.** At 0.5B with a short fine-tune, the variance between seeds can be larger than the effect you are looking for. Three per arm minimum, and report mean ± deviation. This is, by a wide margin, the most common way a small-scale result turns out to be noise.

**Identical budget.** Same tokens, same steps, same LR schedule across all four cells. A difference in optimal LR between arms invalidates the comparison.

**Evals beyond PPL.** Wikitext-2 only measures wikitext-2. Add perplexity on a held-out set from another distribution, and with lm-eval-harness a handful of zero-shot tasks where Qwen-0.5B is clearly above chance: LAMBADA, HellaSwag, PIQA, ARC-easy. If the AR improves PPL but not the tasks, that has to be said too.

## 5. Three things in the README that will get you called out

**The effective bits.** Qwen1.5-0.5B has a vocabulary of ~151k; the embeddings are around a third of the parameters and they stay in FP32. Announcing "1.125 bits/weight" while a third of the model goes unquantized is exactly what gets flagged on Hacker News. Report **total** bits per parameter for the checkpoint, and separately the ones for the linear layers. The 2.8× is dominated by the embeddings that did not shrink.

**The 5-8× throughput is not yours.** It belongs to PrismML's Metal kernels over the Bonsai models. Your measured number is 0.3× on CPU. Separate it typographically or you will be accused of appropriating someone else's result, and rightly so.

**R grows unbounded.** `R_l = R_{l-1} + A_l` accumulates without normalizing; by layer 24 you are carrying 24 summed attention outputs. With α≈0 nothing happens, but if α grows the magnitude blows up. Monitor activation norms, and have the EMA variant (`R_l = (1-β)R_{l-1} + βA_l`) or a depth-normalized one ready as plan B. If you end up needing it, that is one more ablation, not a failure.

## 6. Scope

A single scale (0.5B) is acceptable for a post and a short preprint if you declare it. If the result comes out positive, replicating it at 1.8B is what turns "curiosity" into "trend" — and it is the difference between a lab reading you or not.

---

An ordering that saves weeks: **α first → C and D with one seed → if there is signal, the full grid with three seeds.**

Where are you right now — do you already have the QAT running, or are you still deciding the dataset and the budget?
