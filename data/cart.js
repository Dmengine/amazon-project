export const cart = [];


export function updateCartQuantity(){
  let cardQuantity = 0;

  cart.forEach((cartItem) => {
    cardQuantity += cartItem.quantity;
  })

  document.querySelector('.js-cart-quantity').
        innerHTML = cardQuantity;

}