
export let cart = [{
  productId: "e43638ce-6aa0-4b85-b27f-e1d07eb678c6",
  quantity: 2,
},
{
  productId: "f8b7f3e3-3b0e-4e3d-8e4c-6f8f1d0f2f6d",
  quantity: 4,
},
];


export function addToCart(productId) {
  const quantitySelector = document.querySelector(`.js-quantity-selector-${productId}`).value;
  const quantity = Number(quantitySelector);
  const addedMessage = document.querySelector(`.js-added-to-cart-${productId}`);
  addedMessage.classList.add('added-to-cart-visible');
  const addedMessageTimeouts = {};


  const previousTimeoutId = addedMessageTimeouts[productId];
      if (previousTimeoutId) {
        clearTimeout(previousTimeoutId);
      }

  const timeoutId = setTimeout(() => {
    addedMessage.classList.remove('added-to-cart-visible');
  }, 2000);

  addedMessageTimeouts[productId] = timeoutId;


  let matchingItem;

  cart.forEach((cartItem) => {
    if (productId === cartItem.productId) {
      matchingItem = cartItem;
    }
  })

  if(matchingItem) {
    matchingItem.quantity += 1;
  } else {
    cart.push({
      productId,
      quantity,
    });
  }

}


export function deleteCartItem(productId){
  const newCart = [];
  cart.forEach((cartItem) => {
    if (cartItem.productId !== productId) {
      newCart.push(cartItem);
    }
  })

  cart = newCart;
}